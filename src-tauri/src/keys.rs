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
    key_type: String,
    public_key: String,
    fingerprint: String,
}

#[derive(Serialize)]
pub struct GeneratedKey {
    private_key: String,
    key_type: String,
    public_key: String,
    fingerprint: String,
}

fn metadata_for_key(key: &PrivateKey) -> Result<KeyMetadata, String> {
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
            PrivateKey::new(KeypairData::Rsa(pair), "terra")
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

#[cfg(test)]
mod tests {
    use super::{derive_public_key, generate_ssh_key, generate_ssh_key_inner, inspect_private_key};
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
}
