use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD_NO_PAD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, NewAead, Payload},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{StaticSecret, PublicKey};
use zeroize::{Zeroize, ZeroizeOnDrop};

type HmacSha256 = Hmac<Sha256>;

const SALT_CL_LEN: usize = 16;
const DEK_LEN: usize = 32;
const RECOVERY_CODE_LEN: usize = 16; // 128 bits = 16 bytes = 22 base64url chars
const NONCE_LEN: usize = 24;

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct KeySession {
    pub dek: [u8; DEK_LEN],
    pub private_key: StaticSecret,
    pub public_key: PublicKey,
    pub salt_cl: [u8; SALT_CL_LEN],
    pub kek: Option<[u8; DEK_LEN]>,
}

impl KeySession {
    pub fn new() -> Self {
        let private_key = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public_key = PublicKey::from(&private_key);
        Self {
            dek: [0u8; DEK_LEN],
            private_key,
            public_key,
            salt_cl: [0u8; SALT_CL_LEN],
            kek: None,
        }
    }
}

#[derive(serde::Serialize)]
pub struct AccountMaterial {
    pub salt_cl: String,
    pub recovery_code: String,
    pub public_key: String,
    pub private_key_wrapped_by_dek: String,
}

#[derive(serde::Serialize)]
pub struct KeyringRows {
    pub dek_wrapped_by_kek: String,
    pub dek_wrapped_by_recovery: String,
    pub private_key_wrapped_by_dek: String,
}

#[derive(serde::Serialize)]
pub struct LoginProof {
    pub verifier: String,
    pub proof: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct EncryptedPayload {
    pub v: u8,
    pub alg: String,
    pub nonce: String,
    pub ct: String,
    #[serde(default)]
    pub aad: String,
}

pub fn derive_kek_bytes(password: &str, salt_cl: &[u8; SALT_CL_LEN]) -> Result<[u8; DEK_LEN], String> {
    let mut kek = [0u8; DEK_LEN];
    let params = argon2::Params::new(32 * 1024, 2, 1, Some(DEK_LEN))
        .map_err(|e| format!("Argon2 params error: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(password.as_bytes(), salt_cl, &mut kek)
        .map_err(|e| format!("Argon2 hash error: {e}"))?;
    Ok(kek)
}

pub fn generate_recovery_code() -> String {
    let mut recovery_bytes = [0u8; RECOVERY_CODE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut recovery_bytes);
    BASE64.encode(recovery_bytes)
}

fn derive_recovery_kek(recovery_code: &str, salt_cl: &[u8; SALT_CL_LEN]) -> Result<[u8; DEK_LEN], String> {
    let recovery_bytes = BASE64
        .decode(recovery_code)
        .map_err(|e| format!("Invalid recovery code base64: {e}"))?;
    let mut recovery_kek = [0u8; DEK_LEN];
    let params = argon2::Params::new(32 * 1024, 2, 1, Some(DEK_LEN))
        .map_err(|e| format!("Argon2 params error: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(&recovery_bytes, salt_cl, &mut recovery_kek)
        .map_err(|e| format!("Argon2 recovery KDF error: {e}"))?;
    Ok(recovery_kek)
}

pub fn generate_account_material(session: &mut KeySession) -> Result<AccountMaterial, String> {
    use rand::RngCore;
    let mut salt_cl = [0u8; SALT_CL_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt_cl);

    let mut dek = [0u8; DEK_LEN];
    rand::rngs::OsRng.fill_bytes(&mut dek);
    session.dek = dek;
    session.salt_cl = salt_cl;

    let private_key = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let public_key = PublicKey::from(&private_key);
    session.private_key = private_key;
    session.public_key = public_key;

    let recovery_code = generate_recovery_code();

    let private_key_bytes = session.private_key.to_bytes();
    let wrapped_private = encrypt_bytes(&dek, &private_key_bytes, b"private_key")?;

    Ok(AccountMaterial {
        salt_cl: BASE64.encode(salt_cl),
        recovery_code,
        public_key: BASE64.encode(public_key.as_bytes()),
        private_key_wrapped_by_dek: wrapped_private,
    })
}

pub fn derive_kek(password: &str, salt_cl_b64: &str, session: &mut KeySession) -> Result<(), String> {
    let salt_cl_bytes = BASE64
        .decode(salt_cl_b64)
        .map_err(|e| format!("Invalid salt_cl base64: {e}"))?;
    if salt_cl_bytes.len() != SALT_CL_LEN {
        return Err("Invalid salt_cl length".to_string());
    }
    let mut salt_cl = [0u8; SALT_CL_LEN];
    salt_cl.copy_from_slice(&salt_cl_bytes);

    let kek = derive_kek_bytes(password, &salt_cl)?;
    session.kek = Some(kek);
    session.salt_cl = salt_cl;
    Ok(())
}

pub fn compute_login_proof(
    kek: &[u8; DEK_LEN],
    server_salt_b64: &str,
    nonce_b64: &str,
) -> Result<LoginProof, String> {
    let server_salt = BASE64
        .decode(server_salt_b64)
        .map_err(|e| format!("Invalid server_salt base64: {e}"))?;

    let params = argon2::Params::new(32 * 1024, 2, 1, Some(DEK_LEN))
        .map_err(|e| format!("Argon2 params error: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut verifier = [0u8; DEK_LEN];
    argon2
        .hash_password_into(kek, &server_salt, &mut verifier)
        .map_err(|e| format!("Argon2 verifier error: {e}"))?;

    let nonce = BASE64
        .decode(nonce_b64)
        .map_err(|e| format!("Invalid nonce base64: {e}"))?;

    let mut mac = <HmacSha256 as hmac::Mac>::new_from_slice(&verifier)
        .map_err(|e| format!("HMAC key error: {e}"))?;
    mac.update(&nonce);
    let proof = mac.finalize().into_bytes();

    Ok(LoginProof {
        verifier: BASE64.encode(verifier),
        proof: BASE64.encode(proof),
    })
}

pub fn build_keyring_rows(
    kek: &[u8; DEK_LEN],
    recovery_code: &str,
    session: &KeySession,
) -> Result<KeyringRows, String> {
    let dek_wrapped_by_kek = encrypt_bytes(kek, &session.dek, b"dek")?;

    let recovery_kek = derive_recovery_kek(recovery_code, &session.salt_cl)?;
    let dek_wrapped_by_recovery = encrypt_bytes(&recovery_kek, &session.dek, b"dek")?;

    let private_key_bytes = session.private_key.to_bytes();
    let private_key_wrapped_by_dek = encrypt_bytes(&session.dek, &private_key_bytes, b"private_key")?;

    Ok(KeyringRows {
        dek_wrapped_by_kek,
        dek_wrapped_by_recovery,
        private_key_wrapped_by_dek,
    })
}

pub fn wrap_dek_with_recovery(
    recovery_code: &str,
    salt_cl_b64: &str,
    session: &KeySession,
) -> Result<String, String> {
    let salt_cl_bytes = BASE64
        .decode(salt_cl_b64)
        .map_err(|e| format!("Invalid salt_cl base64: {e}"))?;
    if salt_cl_bytes.len() != SALT_CL_LEN {
        return Err("Invalid salt_cl length".to_string());
    }
    if salt_cl_bytes.iter().all(|&b| b == 0) {
        return Err("salt_cl not derived".to_string());
    }
    let mut salt_cl = [0u8; SALT_CL_LEN];
    salt_cl.copy_from_slice(&salt_cl_bytes);

    let recovery_kek = derive_recovery_kek(recovery_code, &salt_cl)?;
    encrypt_bytes(&recovery_kek, &session.dek, b"dek")
}

pub fn encrypt_secret(
    plaintext: &str,
    record_type: &str,
    session: &KeySession,
) -> Result<String, String> {
    let payload = encrypt_bytes(&session.dek, plaintext.as_bytes(), record_type.as_bytes())?;
    Ok(payload)
}

pub fn decrypt_secret(payload_b64: &str, session: &KeySession) -> Result<String, String> {
    let plaintext = decrypt_bytes(payload_b64, &session.dek)?;
    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {e}"))
}

pub fn unwrap_dek(kek: &[u8; DEK_LEN], wrapped_b64: &str, session: &mut KeySession) -> Result<(), String> {
    let dek_bytes = decrypt_bytes(wrapped_b64, kek)
        .map_err(|_| "Incorrect password".to_string())?;
    if dek_bytes.len() != DEK_LEN {
        return Err("Invalid DEK length".to_string());
    }
    let mut dek = [0u8; DEK_LEN];
    dek.copy_from_slice(&dek_bytes);
    session.dek = dek;
    Ok(())
}

pub fn recovery_unwrap_dek(
    recovery_code: &str,
    salt_cl_b64: &str,
    wrapped_b64: &str,
    session: &mut KeySession,
) -> Result<(), String> {
    let salt_cl_bytes = BASE64
        .decode(salt_cl_b64)
        .map_err(|e| format!("Invalid salt_cl base64: {e}"))?;
    if salt_cl_bytes.len() != SALT_CL_LEN {
        return Err("Invalid salt_cl length".to_string());
    }
    let mut salt_cl = [0u8; SALT_CL_LEN];
    salt_cl.copy_from_slice(&salt_cl_bytes);

    let recovery_kek = derive_recovery_kek(recovery_code, &salt_cl)?;

    let dek_bytes = decrypt_bytes(wrapped_b64, &recovery_kek)
        .map_err(|_| "Incorrect recovery code".to_string())?;
    if dek_bytes.len() != DEK_LEN {
        return Err("Invalid DEK length".to_string());
    }
    let mut dek = [0u8; DEK_LEN];
    dek.copy_from_slice(&dek_bytes);
    session.dek = dek;
    session.salt_cl = salt_cl;
    Ok(())
}

pub fn unwrap_private_key(wrapped_b64: &str, session: &mut KeySession) -> Result<(), String> {
    let private_key_bytes = decrypt_bytes(wrapped_b64, &session.dek)
        .map_err(|_| "Incorrect password".to_string())?;
    if private_key_bytes.len() != 32 {
        return Err("Invalid private key length".to_string());
    }
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&private_key_bytes);
    session.private_key = StaticSecret::from(key_bytes);
    session.public_key = PublicKey::from(&session.private_key);
    key_bytes.zeroize();
    Ok(())
}

pub fn sign_challenge(nonce_b64: &str, session: &KeySession) -> Result<String, String> {
    let nonce = BASE64
        .decode(nonce_b64)
        .map_err(|e| format!("Invalid nonce base64: {e}"))?;

    use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};
    let shared_secret = x25519(session.private_key.to_bytes(), X25519_BASEPOINT_BYTES);

    let mut mac = <HmacSha256 as hmac::Mac>::new_from_slice(&shared_secret)
        .map_err(|e| format!("HMAC key error: {e}"))?;
    mac.update(&nonce);
    let signature = mac.finalize().into_bytes();

    Ok(BASE64.encode(signature))
}

pub fn lock(session: &mut KeySession) {
    session.dek.zeroize();
    session.kek.zeroize();
    session.private_key.zeroize();
    session.salt_cl.zeroize();
}

pub fn wrap_dek(session: &KeySession) -> Result<String, String> {
    let kek = session.kek.ok_or("KEK not derived")?;
    encrypt_bytes(&kek, &session.dek, b"dek")
}

pub fn unlock(
    password: &str,
    salt_cl_b64: &str,
    wrapped_dek_b64: &str,
    session: &mut KeySession,
) -> Result<(), String> {
    derive_kek(password, salt_cl_b64, session)?;
    let kek = session.kek.ok_or("KEK not derived")?;
    unwrap_dek(&kek, wrapped_dek_b64, session)?;
    Ok(())
}

fn encrypt_bytes(key: &[u8; DEK_LEN], plaintext: &[u8], aad: &[u8]) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from(nonce_bytes);

    let ct = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|e| format!("Encryption error: {e}"))?;

    let payload = EncryptedPayload {
        v: 1,
        alg: "xchacha20poly1305".to_string(),
        nonce: BASE64.encode(nonce_bytes),
        ct: BASE64.encode(&ct),
        aad: BASE64.encode(aad),
    };

    serde_json::to_string(&payload).map_err(|e| format!("JSON error: {e}"))
}

fn decrypt_bytes(payload_b64: &str, key: &[u8; DEK_LEN]) -> Result<Vec<u8>, String> {
    let payload: EncryptedPayload = serde_json::from_str(payload_b64)
        .map_err(|e| format!("Invalid payload JSON: {e}"))?;

    if payload.v != 1 {
        return Err("Unsupported payload version".to_string());
    }
    if payload.alg != "xchacha20poly1305" {
        return Err("Unsupported algorithm".to_string());
    }

    let nonce_bytes: [u8; NONCE_LEN] = BASE64
        .decode(&payload.nonce)
        .map_err(|e| format!("Invalid nonce base64: {e}"))?
        .try_into()
        .map_err(|_| "Invalid nonce length".to_string())?;
    let nonce = XNonce::from(nonce_bytes);

    let ct = BASE64
        .decode(&payload.ct)
        .map_err(|e| format!("Invalid ciphertext base64: {e}"))?;

    let aad = BASE64
        .decode(&payload.aad)
        .map_err(|e| format!("Invalid aad base64: {e}"))?;

    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(&nonce, Payload { msg: ct.as_ref(), aad: aad.as_ref() })
        .map_err(|e| format!("Decryption error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_kek_deterministic() {
        let salt = [1u8; SALT_CL_LEN];
        let kek1 = derive_kek_bytes("password", &salt).unwrap();
        let kek2 = derive_kek_bytes("password", &salt).unwrap();
        assert_eq!(kek1, kek2);
    }

    #[test]
    fn test_derive_kek_different_passwords() {
        let salt = [1u8; SALT_CL_LEN];
        let kek1 = derive_kek_bytes("password1", &salt).unwrap();
        let kek2 = derive_kek_bytes("password2", &salt).unwrap();
        assert_ne!(kek1, kek2);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let mut key = [0u8; DEK_LEN];
        rand::rngs::OsRng.fill_bytes(&mut key);

        let plaintext = b"hello world";
        let aad = b"host";
        let encrypted = encrypt_bytes(&key, plaintext, aad).unwrap();
        let decrypted = decrypt_bytes(&encrypted, &key).unwrap();
        assert_eq!(plaintext.to_vec(), decrypted);
    }

    #[test]
    fn test_encrypt_decrypt_wrong_key() {
        let mut key1 = [0u8; DEK_LEN];
        let mut key2 = [0u8; DEK_LEN];
        rand::rngs::OsRng.fill_bytes(&mut key1);
        rand::rngs::OsRng.fill_bytes(&mut key2);

        let plaintext = b"secret data";
        let aad = b"host";
        let encrypted = encrypt_bytes(&key1, plaintext, aad).unwrap();
        let result = decrypt_bytes(&encrypted, &key2);
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_account_material() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        assert!(!material.salt_cl.is_empty());
        assert!(!material.recovery_code.is_empty());
        assert!(!material.public_key.is_empty());
        assert!(!material.private_key_wrapped_by_dek.is_empty());

        // DEK should be set in session
        assert_ne!(session.dek, [0u8; DEK_LEN]);
    }

    #[test]
    fn test_build_keyring_rows() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        assert!(!keyring.dek_wrapped_by_kek.is_empty());
        assert!(!keyring.dek_wrapped_by_recovery.is_empty());
        assert!(!keyring.private_key_wrapped_by_dek.is_empty());
    }

    #[test]
    fn test_unwrap_dek() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        let original_dek = session.dek;

        // Clear session and unwrap
        lock(&mut session);
        assert_eq!(session.dek, [0u8; DEK_LEN]);

        unwrap_dek(&kek, &keyring.dek_wrapped_by_kek, &mut session).unwrap();
        assert_eq!(session.dek, original_dek);
    }

    #[test]
    fn test_recovery_unwrap_dek() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        let original_dek = session.dek;
        let salt_cl_b64 = material.salt_cl.clone();

        // Clear session and unwrap with recovery
        lock(&mut session);
        recovery_unwrap_dek(&material.recovery_code, &salt_cl_b64, &keyring.dek_wrapped_by_recovery, &mut session).unwrap();
        assert_eq!(session.dek, original_dek);
    }

    #[test]
    fn test_wrap_dek_with_recovery_roundtrip() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let wrapped = wrap_dek_with_recovery(&material.recovery_code, &material.salt_cl, &session).unwrap();
        let original_dek = session.dek;

        lock(&mut session);
        recovery_unwrap_dek(&material.recovery_code, &material.salt_cl, &wrapped, &mut session).unwrap();
        assert_eq!(session.dek, original_dek);
    }

    #[test]
    fn test_wrap_dek_with_recovery_wrong_code() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let wrapped = wrap_dek_with_recovery(&material.recovery_code, &material.salt_cl, &session).unwrap();
        let wrong_code = generate_recovery_code();

        lock(&mut session);
        let result = recovery_unwrap_dek(&wrong_code, &material.salt_cl, &wrapped, &mut session);
        assert!(result.is_err());
    }

    #[test]
    fn test_wrap_dek_with_recovery_rejects_underved_salt() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let zero_salt = BASE64.encode([0u8; SALT_CL_LEN]);
        let result = wrap_dek_with_recovery(&material.recovery_code, &zero_salt, &session);
        assert!(result.is_err());
    }

    #[test]
    fn test_unwrap_private_key_roundtrip() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();
        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        let original_public_key = session.public_key;

        lock(&mut session);
        recovery_unwrap_dek(
            &material.recovery_code,
            &material.salt_cl,
            &keyring.dek_wrapped_by_recovery,
            &mut session,
        )
        .unwrap();
        unwrap_private_key(&keyring.private_key_wrapped_by_dek, &mut session).unwrap();

        assert_eq!(session.public_key, original_public_key);

        let nonce = BASE64.encode([7u8; 32]);
        let signature = sign_challenge(&nonce, &session).unwrap();
        assert!(!signature.is_empty());
    }

    #[test]
    fn test_unwrap_private_key_wrong_dek() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();
        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        let mut other = KeySession::new();
        let _ = generate_account_material(&mut other).unwrap();

        let result = unwrap_private_key(&keyring.private_key_wrapped_by_dek, &mut other);
        assert!(result.is_err());
    }

    #[test]
    fn test_sign_challenge() {
        let mut session = KeySession::new();
        let _ = generate_account_material(&mut session).unwrap();

        let nonce = BASE64.encode([42u8; 32]);
        let signature = sign_challenge(&nonce, &session).unwrap();
        assert!(!signature.is_empty());

        // Same nonce should produce same signature
        let signature2 = sign_challenge(&nonce, &session).unwrap();
        assert_eq!(signature, signature2);
    }

    #[test]
    fn test_encrypt_secret_roundtrip() {
        let mut session = KeySession::new();
        let _ = generate_account_material(&mut session).unwrap();

        let plaintext = "my secret host password";
        let record_type = "host";
        let encrypted = encrypt_secret(plaintext, record_type, &session).unwrap();
        let decrypted = decrypt_secret(&encrypted, &session).unwrap();
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_lock_unlock() {
        let mut session = KeySession::new();
        let material = generate_account_material(&mut session).unwrap();

        let kek = derive_kek_bytes("password", &session.salt_cl).unwrap();
        let keyring = build_keyring_rows(&kek, &material.recovery_code, &session).unwrap();

        let original_dek = session.dek;
        let salt_cl_b64 = material.salt_cl.clone();

        lock(&mut session);
        assert_eq!(session.dek, [0u8; DEK_LEN]);
        assert!(session.kek.is_none());

        unlock("password", &salt_cl_b64, &keyring.dek_wrapped_by_kek, &mut session).unwrap();
        assert_eq!(session.dek, original_dek);
    }

    #[test]
    fn test_compute_login_proof() {
        let kek = derive_kek_bytes("password", &[1u8; SALT_CL_LEN]).unwrap();
        let server_salt = BASE64.encode([2u8; 16]);
        let nonce = BASE64.encode([3u8; 32]);

        let proof = compute_login_proof(&kek, &server_salt, &nonce).unwrap();
        assert!(!proof.verifier.is_empty());
        assert!(!proof.proof.is_empty());

        // Same inputs should produce same proof
        let proof2 = compute_login_proof(&kek, &server_salt, &nonce).unwrap();
        assert_eq!(proof.verifier, proof2.verifier);
        assert_eq!(proof.proof, proof2.proof);
    }
}
