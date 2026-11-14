use russh::keys::ssh_key::{
    getrandom::SysRng,
    private::{KeypairData, RsaKeypair},
    rand_core::UnwrapErr,
    LineEnding,
};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PrivateKey};
use serde::Serialize;

#[derive(Serialize)]
pub struct KeyMetadata {
    pub(crate) key_type: String,
    public_key: String,
    pub(crate) fingerprint: String,
}

#[derive(Serialize)]
pub struct GeneratedKey {
    private_key: String,
    key_type: String,
    public_key: String,
    fingerprint: String,
}

pub(crate) fn metadata_for_key(key: &PrivateKey) -> Result<KeyMetadata, String> {
    let key_type = match key.algorithm() {
        Algorithm::Ed25519 => "ed25519",
        Algorithm::Rsa { .. } => "rsa",
        Algorithm::Ecdsa { .. } => "ecdsa",
        other => return Err(format!("Unsupported SSH key type: {other}")),
    };
    Ok(KeyMetadata {
        key_type: key_type.to_string(),
        public_key: key.public_key().to_openssh().map_err(|e| e.to_string())?,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

#[tauri::command]
pub fn inspect_private_key(
    private_key: String,
    passphrase: Option<String>,
) -> Result<KeyMetadata, String> {
    let key = russh::keys::decode_secret_key(&private_key, passphrase.as_deref())
        .map_err(|e| format!("Could not read private key: {e}"))?;
    metadata_for_key(&key)
}

fn generate_ssh_key_inner(key_type: String) -> Result<GeneratedKey, String> {
    let mut rng = UnwrapErr(SysRng);
    let key = match key_type.as_str() {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        "ecdsa" => PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        ),
        "rsa" => {
            let pair = RsaKeypair::random(&mut rng, 4096).map_err(|e| e.to_string())?;
            PrivateKey::new(KeypairData::Rsa(pair), "shetu")
        }
        _ => return Err("Unsupported SSH key type".to_string()),
    }
    .map_err(|e| format!("Could not generate SSH key: {e}"))?;
    let metadata = metadata_for_key(&key)?;
    let private_key = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(GeneratedKey {
        private_key,
        key_type: metadata.key_type,
        public_key: metadata.public_key,
        fingerprint: metadata.fingerprint,
    })
}

#[tauri::command]
pub async fn generate_ssh_key(key_type: String) -> Result<GeneratedKey, String> {
    tauri::async_runtime::spawn_blocking(move || generate_ssh_key_inner(key_type))
        .await
        .map_err(|e| format!("Key generation task failed: {e}"))?
}

#[tauri::command]
pub fn derive_public_key(private_key: String) -> Result<String, String> {
    let key = russh::keys::decode_secret_key(&private_key, None)
        .map_err(|e| format!("Could not read private key: {e}"))?;
    key.public_key()
        .to_openssh()
        .map_err(|e| format!("Could not encode public key: {e}"))
}

/// Converts PuTTY `.ppk` text to OpenSSH text, re-encrypted with the same passphrase if given.
#[tauri::command]
pub fn convert_ppk(text: String, passphrase: Option<String>) -> Result<String, String> {
    use russh::keys::ssh_key::Error;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let key = PrivateKey::from_ppk(&text, passphrase.clone()).map_err(|e| match &e {
        // PpkParseError is not re-exported by ssh-key, so match its variant name.
        Error::Ppk(p) if format!("{p:?}") == "Encrypted" => "PPK_ENCRYPTED".to_string(),
        Error::Ppk(p) if format!("{p:?}") == "IncorrectMac" => "PPK_BAD_PASSPHRASE".to_string(),
        e => format!("Could not read PuTTY key: {e}"),
    })?;
    let key = match passphrase {
        Some(p) => key
            .encrypt(&mut UnwrapErr(SysRng), p)
            .map_err(|e| format!("Could not encrypt key: {e}"))?,
        None => key,
    };
    key.to_openssh(LineEnding::LF)
        .map(|s| s.to_string())
        .map_err(|e| format!("Could not encode key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        convert_ppk, derive_public_key, generate_ssh_key, generate_ssh_key_inner,
        inspect_private_key,
    };
    use russh::keys::{
        ssh_key::private::{Ed25519Keypair, KeypairData},
        PrivateKey,
    };

    #[test]
    fn derives_openssh_public_key_from_private_key() {
        let private = PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[7u8; 32])),
            "test",
        )
        .unwrap();
        let pem = private
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let expected = private.public_key().to_openssh().unwrap();
        assert_eq!(derive_public_key(pem.to_string()).unwrap(), expected);
    }

    #[test]
    fn rejects_invalid_private_key() {
        assert!(derive_public_key("not a private key".into()).is_err());
    }
    #[test]
    fn inspects_private_key_algorithm_and_rejects_bad_passphrase() {
        let private = PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[7u8; 32])),
            "test",
        )
        .unwrap();
        let pem = private
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let metadata = inspect_private_key(pem.to_string(), None).unwrap();
        assert_eq!(metadata.key_type, "ed25519");
        assert_eq!(
            metadata.public_key,
            private.public_key().to_openssh().unwrap()
        );
        assert!(!metadata.fingerprint.is_empty());
    }

    #[test]
    fn inspects_encrypted_private_key_only_with_correct_passphrase() {
        let private = PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[9u8; 32])),
            "test",
        )
        .unwrap();
        let encrypted = private
            .encrypt(
                &mut russh::keys::ssh_key::getrandom::SysRng,
                "correct-passphrase",
            )
            .unwrap();
        let pem = encrypted
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .to_string();
        assert!(inspect_private_key(pem.clone(), None).is_err());
        assert!(inspect_private_key(pem.clone(), Some("wrong-passphrase".into())).is_err());
        let metadata = inspect_private_key(pem, Some("correct-passphrase".into())).unwrap();
        assert_eq!(metadata.key_type, "ed25519");
        assert_eq!(
            metadata.public_key,
            private.public_key().to_openssh().unwrap()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rsa_generation_does_not_block_the_runtime() {
        let task = tokio::spawn(generate_ssh_key("rsa".to_string()));
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "RSA generation blocked the runtime thread"
        );
        let generated = task.await.unwrap().unwrap();
        assert_eq!(generated.key_type, "rsa");
    }

    #[test]
    fn generates_valid_keys_for_each_offered_algorithm() {
        for algorithm in ["ed25519", "rsa", "ecdsa"] {
            let generated = generate_ssh_key_inner(algorithm.to_string()).unwrap();
            let metadata = inspect_private_key(generated.private_key.clone(), None).unwrap();
            assert_eq!(metadata.key_type, algorithm);
            assert_eq!(metadata.public_key, generated.public_key);
            assert!(!generated.fingerprint.is_empty());
        }
        assert!(generate_ssh_key_inner("unsupported".into()).is_err());
    }

    // PPK fixtures are generated at test time (no puttygen available) following the
    // PuTTY format spec, from a fixed ed25519 seed, and validated by ssh-key's parser.
    fn ppk_fixture(version: u8, passphrase: Option<&str>) -> String {
        use aes::Aes256;
        use base64::{engine::general_purpose::STANDARD, Engine};
        use cbc::cipher::{block_padding::NoPadding, BlockModeEncrypt, KeyIvInit};
        use hmac::{Hmac, Mac};
        use sha1::{Digest, Sha1};

        fn string(buf: &mut Vec<u8>, data: &[u8]) {
            buf.extend((data.len() as u32).to_be_bytes());
            buf.extend(data);
        }
        let key = ed_key(5);
        let KeypairData::Ed25519(kp) = key.key_data() else {
            unreachable!()
        };
        let mut public = vec![];
        string(&mut public, b"ssh-ed25519");
        string(&mut public, &kp.public.0);
        let seed = kp.private.to_bytes();
        let mut mpint = vec![];
        if seed[0] & 0x80 != 0 {
            mpint.push(0);
        }
        mpint.extend(seed);
        let mut private = vec![];
        string(&mut private, &mpint);
        private.resize(private.len().div_ceil(16) * 16, 0);

        let (encryption, comment) = (
            if passphrase.is_some() {
                "aes256-cbc"
            } else {
                "none"
            },
            "fixture",
        );
        let mut mac_input = vec![];
        for field in [
            &b"ssh-ed25519"[..],
            encryption.as_bytes(),
            comment.as_bytes(),
            &public,
            &private,
        ] {
            string(&mut mac_input, field);
        }
        let (mac, stored_private) = match (version, passphrase) {
            (3, None) => {
                let mut m = Hmac::<sha2::Sha256>::new_from_slice(&[]).unwrap();
                m.update(&mac_input);
                (m.finalize().into_bytes().to_vec(), private)
            }
            (2, Some(pass)) => {
                let sha = |n: u32| {
                    let mut h = Sha1::new();
                    h.update(n.to_be_bytes());
                    h.update(pass.as_bytes());
                    h.finalize()
                };
                let mut aes_key = sha(0).to_vec();
                aes_key.extend(sha(1));
                aes_key.truncate(32);
                let mut h = Sha1::new();
                h.update(b"putty-private-key-file-mac-key");
                h.update(pass.as_bytes());
                let mut m = Hmac::<Sha1>::new_from_slice(&h.finalize()).unwrap();
                m.update(&mac_input);
                let mut enc = private.clone();
                let len = enc.len();
                cbc::Encryptor::<Aes256>::new_from_slices(&aes_key, &[0u8; 16])
                    .unwrap()
                    .encrypt_padded::<NoPadding>(&mut enc, len)
                    .unwrap();
                (m.finalize().into_bytes().to_vec(), enc)
            }
            _ => panic!("unsupported fixture combination"),
        };
        let lines = |b: &[u8]| {
            let e = STANDARD.encode(b);
            let l: Vec<&str> = e
                .as_bytes()
                .chunks(64)
                .map(|c| std::str::from_utf8(c).unwrap())
                .collect();
            format!("{}\n{}\n", l.len(), l.join("\n"))
        };
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        let (pub_l, priv_l) = (lines(&public), lines(&stored_private));
        format!(
            "PuTTY-User-Key-File-{version}: ssh-ed25519\nEncryption: {encryption}\nComment: {comment}\nPublic-Lines: {pub_l}Private-Lines: {priv_l}Private-MAC: {hex}\n"
        )
    }

    fn ed_key(seed: u8) -> PrivateKey {
        PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&[seed; 32])),
            "",
        )
        .unwrap()
    }

    #[test]
    fn ppk_fixtures_parse_with_ssh_key() {
        PrivateKey::from_ppk(ppk_fixture(3, None), None).unwrap();
        PrivateKey::from_ppk(ppk_fixture(2, Some("pw")), Some("pw".into())).unwrap();
    }

    #[test]
    fn ppk_v3_unencrypted_converts() {
        let out = convert_ppk(ppk_fixture(3, None), None).unwrap();
        let key = russh::keys::decode_secret_key(&out, None).unwrap();
        assert_eq!(
            key.public_key().key_data(),
            ed_key(5).public_key().key_data()
        );
    }

    #[test]
    fn ppk_v2_encrypted_converts_with_passphrase() {
        let out = convert_ppk(ppk_fixture(2, Some("pw")), Some("pw".into())).unwrap();
        assert!(russh::keys::decode_secret_key(&out, None).is_err());
        let key = russh::keys::decode_secret_key(&out, Some("pw")).unwrap();
        assert_eq!(
            key.public_key().key_data(),
            ed_key(5).public_key().key_data()
        );
    }

    #[test]
    fn ppk_encrypted_without_passphrase() {
        assert_eq!(
            convert_ppk(ppk_fixture(2, Some("pw")), None).unwrap_err(),
            "PPK_ENCRYPTED"
        );
    }

    #[test]
    fn ppk_wrong_passphrase() {
        assert_eq!(
            convert_ppk(ppk_fixture(2, Some("pw")), Some("nope".into())).unwrap_err(),
            "PPK_BAD_PASSPHRASE"
        );
    }
}
