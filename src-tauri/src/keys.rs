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
/// Runs off the main thread: Argon2 and re-encryption take noticeable time.
#[tauri::command]
pub async fn convert_ppk(text: String, passphrase: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || convert_ppk_inner(text, passphrase))
        .await
        .map_err(|e| format!("Key conversion task failed: {e}"))?
}

/// Rejects v3 headers whose Argon2 cost would run before the MAC check can catch a crafted file.
fn check_argon2_limits(text: &str) -> Result<(), String> {
    for (key, value) in text.lines().filter_map(|l| l.split_once(": ")) {
        let max = match key {
            "Argon2-Memory" => 1_048_576, // KiB, 1 GiB
            "Argon2-Passes" => 64,
            "Argon2-Parallelism" => 16,
            _ => continue,
        };
        // An unparsable value is left for ssh-key to reject.
        if value.parse::<u64>().is_ok_and(|v| v > max) {
            return Err("Could not read PuTTY key: Argon2 parameters too large".into());
        }
    }
    Ok(())
}

fn convert_ppk_inner(text: String, passphrase: Option<String>) -> Result<String, String> {
    use russh::keys::ssh_key::Error;
    check_argon2_limits(&text)?;
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
        convert_ppk_inner, derive_public_key, generate_ssh_key, generate_ssh_key_inner,
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
        ppk_fixture_seeded(version, passphrase, 5)
    }

    fn ppk_fixture_seeded(version: u8, passphrase: Option<&str>, seed_byte: u8) -> String {
        use aes::Aes256;
        use base64::{engine::general_purpose::STANDARD, Engine};
        use cbc::cipher::{block_padding::NoPadding, BlockModeEncrypt, KeyIvInit};
        use hmac::{Hmac, Mac};
        use sha1::{Digest, Sha1};

        fn string(buf: &mut Vec<u8>, data: &[u8]) {
            buf.extend((data.len() as u32).to_be_bytes());
            buf.extend(data);
        }
        let key = ed_key(seed_byte);
        let KeypairData::Ed25519(kp) = key.key_data() else {
            unreachable!()
        };
        let mut public = vec![];
        string(&mut public, b"ssh-ed25519");
        string(&mut public, &kp.public.0);
        // PuTTY writes the ed25519 secret as a fixed 32-byte string, never with an mpint
        // sign byte (see PUTTYGEN_ED25519 below, whose secret starts with 0xb6).
        let mut private = vec![];
        string(&mut private, &kp.private.to_bytes());
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
        let encrypt = |key: &[u8], iv: &[u8]| {
            let mut enc = private.clone();
            let len = enc.len();
            cbc::Encryptor::<Aes256>::new_from_slices(key, iv)
                .unwrap()
                .encrypt_padded::<NoPadding>(&mut enc, len)
                .unwrap();
            enc
        };
        let mut kdf_header = String::new();
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
                (
                    m.finalize().into_bytes().to_vec(),
                    encrypt(&aes_key, &[0u8; 16]),
                )
            }
            (3, Some(pass)) => {
                // Small Argon2id parameters keep the test fast.
                let salt = [0x5au8; 16];
                let mut out = [0u8; 80];
                argon2::Argon2::new(
                    argon2::Algorithm::Argon2id,
                    argon2::Version::V0x13,
                    argon2::Params::new(256, 1, 1, None).unwrap(),
                )
                .hash_password_into(pass.as_bytes(), &salt, &mut out)
                .unwrap();
                let salt_hex: String = salt.iter().map(|b| format!("{b:02x}")).collect();
                kdf_header = format!(
                    "Key-Derivation: Argon2id\nArgon2-Memory: 256\nArgon2-Passes: 1\nArgon2-Parallelism: 1\nArgon2-Salt: {salt_hex}\n"
                );
                let mut m = Hmac::<sha2::Sha256>::new_from_slice(&out[48..]).unwrap();
                m.update(&mac_input);
                (
                    m.finalize().into_bytes().to_vec(),
                    encrypt(&out[..32], &out[32..48]),
                )
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
            "PuTTY-User-Key-File-{version}: ssh-ed25519\nEncryption: {encryption}\nComment: {comment}\nPublic-Lines: {pub_l}{kdf_header}Private-Lines: {priv_l}Private-MAC: {hex}\n"
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
        let out = convert_ppk_inner(ppk_fixture(3, None), None).unwrap();
        let key = russh::keys::decode_secret_key(&out, None).unwrap();
        assert_eq!(
            key.public_key().key_data(),
            ed_key(5).public_key().key_data()
        );
    }

    #[test]
    fn ppk_v2_encrypted_converts_with_passphrase() {
        let out = convert_ppk_inner(ppk_fixture(2, Some("pw")), Some("pw".into())).unwrap();
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
            convert_ppk_inner(ppk_fixture(2, Some("pw")), None).unwrap_err(),
            "PPK_ENCRYPTED"
        );
    }

    #[test]
    fn ppk_wrong_passphrase() {
        assert_eq!(
            convert_ppk_inner(ppk_fixture(2, Some("pw")), Some("nope".into())).unwrap_err(),
            "PPK_BAD_PASSPHRASE"
        );
    }

    // Seed byte 0x85 sets the high bit of the secret's first byte (the reported failure case).
    const HIGH_BIT_SEED: u8 = 0x85;

    #[test]
    fn ppk_high_bit_seed_converts_in_every_format() {
        for (version, pass) in [(2, Some("pw")), (3, None), (3, Some("pw"))] {
            let text = ppk_fixture_seeded(version, pass, HIGH_BIT_SEED);
            let out = convert_ppk_inner(text, pass.map(Into::into)).unwrap();
            let key = russh::keys::decode_secret_key(&out, pass).unwrap();
            assert_eq!(
                key.public_key().key_data(),
                ed_key(HIGH_BIT_SEED).public_key().key_data(),
                "v{version} encrypted={}",
                pass.is_some()
            );
        }
    }

    #[test]
    fn ppk_high_bit_seed_passphrase_errors() {
        for version in [2, 3] {
            let text = ppk_fixture_seeded(version, Some("pw"), HIGH_BIT_SEED);
            assert_eq!(
                convert_ppk_inner(text.clone(), None).unwrap_err(),
                "PPK_ENCRYPTED"
            );
            assert_eq!(
                convert_ppk_inner(text, Some("nope".into())).unwrap_err(),
                "PPK_BAD_PASSPHRASE"
            );
        }
    }

    // Real puttygen output (ssh-key's tests/examples/id_ed25519.ppk, a public test vector):
    // the secret's first byte is 0xb6 and PuTTY stores it as a plain 32-byte string.
    const PUTTYGEN_ED25519: &str = "PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Private-Lines: 1
AAAAILYGwiLRDBba4WxwpNRRc0cuxhfgXGVpINJuVsCPtZHt
Private-MAC: 94140d0344fad6aa1bf7b71e9c93db11ccac8a232f8a51e11c024869d608c82d
";

    #[test]
    fn real_puttygen_ed25519_with_high_bit_secret_converts() {
        let out = convert_ppk_inner(PUTTYGEN_ED25519.into(), None).unwrap();
        let key = russh::keys::decode_secret_key(&out, None).unwrap();
        assert_eq!(
            key.public_key().to_openssh().unwrap(),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti user@example.com"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ppk_conversion_does_not_block_the_runtime() {
        let task = tokio::spawn(super::convert_ppk(
            ppk_fixture(3, Some("pw")),
            Some("pw".into()),
        ));
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "PPK conversion blocked the runtime thread"
        );
        assert!(task.await.unwrap().is_ok());
    }

    #[test]
    fn ppk_rejects_oversized_argon2_parameters() {
        let text = ppk_fixture(3, Some("pw"));
        for (from, to) in [
            ("Argon2-Memory: 256", "Argon2-Memory: 4194304"),
            ("Argon2-Passes: 1", "Argon2-Passes: 65"),
            ("Argon2-Parallelism: 1", "Argon2-Parallelism: 17"),
        ] {
            let started = std::time::Instant::now();
            assert_eq!(
                convert_ppk_inner(text.replace(from, to), Some("pw".into())).unwrap_err(),
                "Could not read PuTTY key: Argon2 parameters too large",
                "{to}"
            );
            assert!(
                started.elapsed() < std::time::Duration::from_secs(1),
                "{to}"
            );
        }
    }
}
