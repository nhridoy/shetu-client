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
    use super::derive_public_key;
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
}
