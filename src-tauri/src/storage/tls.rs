//! Trusting one server's self-signed certificate: a verifier that accepts what the system
//! trusts or exactly the pinned certificate, the HTTP client built on it, and a probe that
//! reads a server's certificate fingerprint to show the user.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::sync::{Arc, Mutex};

/// Why a background transfer to a server with an untrusted certificate stops (it never prompts).
pub const CERT_UNTRUSTED: &str =
    "The server's certificate isn't trusted — open the account to review it";

/// A certificate's SHA-256, lowercase hex: what the user compares and what an account pins.
pub fn sha256_hex(der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The app's TLS provider: ring, as everywhere else (no aws-lc).
fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts a chain the system trusts for the host, or a leaf that is exactly the pinned
/// certificate. Anything else is refused, so a pin never weakens a valid certificate's check.
#[derive(Debug)]
pub struct PinnedVerifier {
    system: rustls_platform_verifier::Verifier,
    pin: Option<String>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.system.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(ok) => Ok(ok),
            Err(e) => match &self.pin {
                Some(pin) if sha256_hex(end_entity.as_ref()) == *pin => {
                    Ok(ServerCertVerified::assertion())
                }
                _ => Err(e),
            },
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.system.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.system.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.system.supported_verify_schemes()
    }
}

/// An HTTP client that trusts the system's roots, plus the pinned certificate if any.
pub fn client_for(pin: Option<&str>) -> Result<reqwest013::Client, String> {
    let config = client_config(pin)?;
    reqwest013::Client::builder()
        .tls_backend_preconfigured(config)
        .build()
        .map_err(|e| format!("TLS setup: {e}"))
}

/// The app's TLS client setup: ring, platform roots, and the account's pin if any.
pub fn client_config(pin: Option<&str>) -> Result<rustls::ClientConfig, String> {
    let provider = provider();
    let verifier = PinnedVerifier {
        system: rustls_platform_verifier::Verifier::new(provider.clone())
            .map_err(|e| format!("TLS setup: {e}"))?,
        pin: pin.map(str::to_lowercase),
    };
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

/// Accepts any certificate and keeps the leaf: only for reading a fingerprint to show.
#[derive(Debug)]
struct Recorder {
    seen: Mutex<Option<Vec<u8>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(end_entity.to_vec());
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The SHA-256 of the certificate a server presents, read without trusting it.
pub async fn probe(host: &str, port: u16) -> Result<String, String> {
    probe_within(host, port, std::time::Duration::from_secs(10)).await
}

pub async fn probe_within(
    host: &str,
    port: u16,
    limit: std::time::Duration,
) -> Result<String, String> {
    let provider = provider();
    let recorder = Arc::new(Recorder {
        seen: Mutex::new(None),
        provider: provider.clone(),
    });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(recorder.clone())
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).map_err(|e| format!("{host}: {e}"))?;
    let handshake = async {
        let tcp = tokio::net::TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("Couldn't reach {host}:{port}: {e}"))?;
        let _ = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await;
        Ok::<(), String>(())
    };
    tokio::time::timeout(limit, handshake)
        .await
        .map_err(|_| format!("{host}:{port} didn't finish the TLS handshake"))??;
    let seen = recorder.seen.lock().ok().and_then(|s| s.clone());
    seen.map(|der| sha256_hex(&der))
        .ok_or_else(|| format!("{host}:{port} didn't present a certificate"))
}

/// The failure (anywhere in its causes) was a certificate the client wouldn't trust.
pub fn is_cert_error(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(e);
    while let Some(err) = cur {
        if matches!(
            err.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        if let Some(inner) = err
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.get_ref())
        {
            if is_cert_error(inner) {
                return true;
            }
        }
        cur = err.source();
    }
    false
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;

    /// A local HTTPS server with a fresh self-signed certificate for `localhost`. Returns its
    /// port and the certificate's DER. Each connection gets a fixed `200 ok` reply.
    pub(crate) async fn self_signed_server() -> (u16, Vec<u8>) {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let der = cert.cert.der().to_vec();
        let key =
            rustls::pki_types::PrivateKeyDer::try_from(cert.signing_key.serialize_der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![der.clone().into()], key)
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let Ok(mut tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut buf = [0u8; 4096];
                    let _ = tls.read(&mut buf).await;
                    let _ = tls
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        (port, der)
    }

    #[tokio::test]
    async fn pinned_verifier_accepts_the_pinned_certificate() {
        let (port, der) = self_signed_server().await;
        let client = client_for(Some(&sha256_hex(&der))).unwrap();
        let res = client
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 200);
    }

    #[tokio::test]
    async fn pinned_verifier_refuses_a_different_certificate() {
        let (port, _) = self_signed_server().await;
        let other = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let client = client_for(Some(&sha256_hex(other.cert.der()))).unwrap();
        let err = client
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(is_cert_error(&err), "{err:?}");
    }

    #[tokio::test]
    async fn no_pin_refuses_a_self_signed_certificate() {
        let (port, _) = self_signed_server().await;
        let err = client_for(None)
            .unwrap()
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(is_cert_error(&err), "{err:?}");
    }

    #[tokio::test]
    async fn probe_reports_the_leaf_fingerprint() {
        let (port, der) = self_signed_server().await;
        assert_eq!(probe("localhost", port).await.unwrap(), sha256_hex(&der));
    }

    #[test]
    fn sha256_hex_is_lowercase_hex() {
        let h = sha256_hex(b"abc");
        assert_eq!(h.len(), 64);
        assert_eq!(&h[..8], "ba7816bf");
    }

    #[tokio::test]
    async fn a_probe_that_never_completes_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let held = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            drop(held);
        });
        let got = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            probe_within("localhost", port, std::time::Duration::from_millis(200)),
        )
        .await;
        assert!(matches!(got, Ok(Err(_))), "{got:?}");
    }
}
