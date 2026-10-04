use base64::{engine::general_purpose::STANDARD_NO_PAD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, NewAead, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RecipientKey {
    pub user_id: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GrantContext {
    pub team_id: String,
    pub vault_id: String,
    pub epoch: u32,
    pub recipient_user_id: String,
    pub recipient_fingerprint: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TeamKeyEnvelope {
    pub version: u8,
    pub context: GrantContext,
    pub ephemeral_public_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

const DOMAIN: &[u8] = b"terra-team-vault-key-envelope-v1";
const LEGACY_DOMAIN: &[u8] = b"termvault-team-vault-key-envelope-v1";

pub fn generate_vault_key() -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut *key);
    key
}

pub fn fingerprint_identity_key(public_key: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(public_key)
        .map_err(|_| "invalid identity key".to_string())?;
    if bytes.len() != 32 {
        return Err("invalid identity key length".into());
    }
    Ok(BASE64.encode(Sha256::digest(bytes)))
}

fn context_bytes(context: &GrantContext) -> Result<Vec<u8>, String> {
    if context.team_id.is_empty()
        || context.vault_id.is_empty()
        || context.epoch == 0
        || context.recipient_user_id.is_empty()
        || context.recipient_fingerprint.is_empty()
    {
        return Err("incomplete team key context".into());
    }
    serde_json::to_vec(context).map_err(|_| "invalid team key context".into())
}

fn derive_aead_key(
    shared: &[u8; 32],
    ephemeral: &[u8; 32],
    recipient: &[u8; 32],
    domain: &[u8],
) -> Result<Zeroizing<[u8; 32]>, String> {
    if shared.iter().all(|byte| *byte == 0) {
        return Err("invalid recipient key".into());
    }
    let mut info = Vec::with_capacity(domain.len() + 64);
    info.extend_from_slice(domain);
    info.extend_from_slice(ephemeral);
    info.extend_from_slice(recipient);
    let hkdf = Hkdf::<Sha256>::new(Some(domain), shared);
    let mut key = Zeroizing::new([0u8; 32]);
    hkdf.expand(&info, &mut *key)
        .map_err(|_| "key derivation failed".to_string())?;
    Ok(key)
}

pub fn seal_key_bytes(
    key: &[u8; 32],
    context: &GrantContext,
    recipient_public_key: &[u8; 32],
) -> Result<TeamKeyEnvelope, String> {
    seal_key_bytes_with_domain(key, context, recipient_public_key, DOMAIN)
}

fn seal_key_bytes_with_domain(
    key: &[u8; 32],
    context: &GrantContext,
    recipient_public_key: &[u8; 32],
    domain: &[u8],
) -> Result<TeamKeyEnvelope, String> {
    let recipient = PublicKey::from(*recipient_public_key);
    if fingerprint_identity_key(&BASE64.encode(recipient_public_key))?
        != context.recipient_fingerprint
    {
        return Err("recipient fingerprint mismatch".into());
    }
    let ephemeral_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let shared = Zeroizing::new(ephemeral_secret.diffie_hellman(&recipient).to_bytes());
    let mut derived = derive_aead_key(
        &shared,
        ephemeral_public.as_bytes(),
        recipient_public_key,
        domain,
    )?;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new((&*derived).into());
    let aad = context_bytes(context)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: key,
                aad: &aad,
            },
        )
        .map_err(|_| "team key encryption failed".to_string())?;
    derived.zeroize();
    Ok(TeamKeyEnvelope {
        version: 1,
        context: context.clone(),
        ephemeral_public_key: BASE64.encode(ephemeral_public.as_bytes()),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

pub fn open_key_bytes(
    envelope: &TeamKeyEnvelope,
    recipient_private_key: &StaticSecret,
) -> Result<Zeroizing<[u8; 32]>, String> {
    if envelope.version != 1 {
        return Err("unsupported team key envelope".into());
    }
    let ephemeral_bytes = BASE64
        .decode(&envelope.ephemeral_public_key)
        .map_err(|_| "invalid ephemeral key".to_string())?;
    let ephemeral_bytes: [u8; 32] = ephemeral_bytes
        .try_into()
        .map_err(|_| "invalid ephemeral key length".to_string())?;
    let recipient_public = PublicKey::from(recipient_private_key);
    if fingerprint_identity_key(&BASE64.encode(recipient_public.as_bytes()))?
        != envelope.context.recipient_fingerprint
    {
        return Err("recipient fingerprint mismatch".into());
    }
    let nonce = BASE64
        .decode(&envelope.nonce)
        .map_err(|_| "invalid envelope nonce".to_string())?;
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| "invalid envelope nonce length".to_string())?;
    let ciphertext = BASE64
        .decode(&envelope.ciphertext)
        .map_err(|_| "invalid envelope ciphertext".to_string())?;
    let ephemeral_public = PublicKey::from(ephemeral_bytes);
    let shared = Zeroizing::new(
        recipient_private_key
            .diffie_hellman(&ephemeral_public)
            .to_bytes(),
    );
    let aad = context_bytes(&envelope.context)?;
    let mut plaintext = None;
    for domain in [DOMAIN, LEGACY_DOMAIN] {
        let derived = derive_aead_key(
            &shared,
            &ephemeral_bytes,
            recipient_public.as_bytes(),
            domain,
        )?;
        let cipher = XChaCha20Poly1305::new((&*derived).into());
        if let Ok(value) = cipher.decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        ) {
            plaintext = Some(value);
            break;
        }
    }
    let plaintext = plaintext.ok_or("team key authentication failed")?;
    let key: [u8; 32] = plaintext
        .try_into()
        .map_err(|_| "invalid team key length".to_string())?;
    Ok(Zeroizing::new(key))
}

pub fn create_team_grants(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    team_id: &str,
    vault_id: &str,
    recipients: &[RecipientKey],
) -> Result<Vec<TeamKeyEnvelope>, String> {
    if !session.unlocked || team_id.is_empty() || vault_id.is_empty() || recipients.is_empty() {
        return Err("team vault cannot be created while locked or without recipients".into());
    }
    let existing = crate::db::team_vault_meta(db, vault_id)?;
    let key = if let Some((stored_team, epoch, state)) = existing {
        if stored_team != team_id
            || epoch != 1
            || state != "ready"
            || crate::db::team_vault_has_row(db, vault_id)?
        {
            return Err("team vault already exists locally".into());
        }
        let (wrapped_team, wrapped) = crate::db::load_wrapped_team_key(db, vault_id, 1)?
            .ok_or("pending team vault key missing")?;
        if wrapped_team != team_id {
            return Err("team vault identity mismatch".into());
        }
        crate::crypto::unwrap_team_key(&wrapped, team_id, vault_id, 1, session)?
    } else {
        generate_vault_key()
    };
    let mut grants = Vec::with_capacity(recipients.len());
    let mut seen = std::collections::HashSet::new();
    for recipient in recipients {
        if recipient.user_id.is_empty() || !seen.insert(&recipient.user_id) {
            return Err("duplicate or missing recipient".into());
        }
        let bytes = BASE64
            .decode(&recipient.public_key)
            .map_err(|_| "invalid recipient key".to_string())?;
        let public: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "invalid recipient key length".to_string())?;
        let context = GrantContext {
            team_id: team_id.into(),
            vault_id: vault_id.into(),
            epoch: 1,
            recipient_user_id: recipient.user_id.clone(),
            recipient_fingerprint: recipient.fingerprint.clone(),
        };
        grants.push(seal_key_bytes(&key, &context, &public)?);
    }
    if crate::db::team_vault_meta(db, vault_id)?.is_none() {
        let wrapped = crate::crypto::wrap_team_key(&key, team_id, vault_id, 1, session)?;
        crate::db::store_wrapped_team_key(db, vault_id, team_id, 1, &wrapped)?;
        crate::db::store_team_vault_meta(db, vault_id, team_id, 1, "ready")?;
    }
    Ok(grants)
}

pub fn grant_team_key(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    vault_id: &str,
    recipient: &RecipientKey,
) -> Result<TeamKeyEnvelope, String> {
    let resolved = resolve_row_key(db, session, vault_id, None, false)?;
    let team_id = resolved.team_id.ok_or("not a team vault")?;
    let epoch = resolved.epoch.ok_or("team key epoch missing")?;
    let bytes = BASE64
        .decode(&recipient.public_key)
        .map_err(|_| "invalid recipient key".to_string())?;
    let public: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "invalid recipient key length".to_string())?;
    let context = GrantContext {
        team_id,
        vault_id: vault_id.into(),
        epoch,
        recipient_user_id: recipient.user_id.clone(),
        recipient_fingerprint: recipient.fingerprint.clone(),
    };
    seal_key_bytes(&resolved.key, &context, &public)
}

pub fn import_team_grant(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    expected_user_id: &str,
    envelope: &TeamKeyEnvelope,
) -> Result<(), String> {
    if !session.unlocked {
        return Err("Vault is locked".into());
    }
    if envelope.context.recipient_user_id != expected_user_id {
        return Err("team key recipient mismatch".into());
    }
    if let Some((team_id, epoch, state)) =
        crate::db::team_vault_meta(db, &envelope.context.vault_id)?
    {
        if team_id != envelope.context.team_id || envelope.context.epoch < epoch {
            return Err("team vault identity or epoch rollback".into());
        }
        if state == "revoked" && envelope.context.epoch == epoch {
            return Err("revoked team vault requires a newer key epoch".into());
        }
    }
    let key = open_key_bytes(envelope, &session.private_key)?;
    let context = &envelope.context;
    if let Some((stored_team, wrapped)) =
        crate::db::load_wrapped_team_key(db, &context.vault_id, context.epoch)?
    {
        if stored_team != context.team_id {
            return Err("team vault identity mismatch".into());
        }
        let cached = crate::crypto::unwrap_team_key(
            &wrapped,
            &context.team_id,
            &context.vault_id,
            context.epoch,
            session,
        )?;
        if *cached != *key {
            return Err("team vault key changed at same epoch".into());
        }
    } else {
        let wrapped = crate::crypto::wrap_team_key(
            &key,
            &context.team_id,
            &context.vault_id,
            context.epoch,
            session,
        )?;
        crate::db::store_wrapped_team_key(
            db,
            &context.vault_id,
            &context.team_id,
            context.epoch,
            &wrapped,
        )?;
    }
    crate::db::store_team_vault_meta(
        db,
        &context.vault_id,
        &context.team_id,
        context.epoch,
        "ready",
    )
}

pub struct ResolvedRowKey {
    pub key: Zeroizing<[u8; 32]>,
    pub epoch: Option<u32>,
    pub team_id: Option<String>,
}

pub fn resolve_row_key(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    vault_id: &str,
    requested_epoch: Option<u32>,
    require_writable: bool,
) -> Result<ResolvedRowKey, String> {
    if !session.unlocked {
        return Err("Vault is locked".into());
    }
    match crate::db::team_vault_meta(db, vault_id)? {
        None => {
            if requested_epoch.is_some() {
                return Err("team key requested for private vault".into());
            }
            Ok(ResolvedRowKey {
                key: Zeroizing::new(session.dek),
                epoch: None,
                team_id: None,
            })
        }
        Some((team_id, current_epoch, state)) => {
            let epoch = requested_epoch.unwrap_or(current_epoch);
            if epoch > current_epoch {
                return Err("future team key epoch".into());
            }
            if require_writable && (epoch != current_epoch || state != "ready") {
                return Err("team vault is not writable".into());
            }
            if state == "revoked" && require_writable {
                return Err("team vault access revoked".into());
            }
            let (stored_team, wrapped) = crate::db::load_wrapped_team_key(db, vault_id, epoch)?
                .ok_or("team vault key unavailable")?;
            if stored_team != team_id {
                return Err("team vault identity mismatch".into());
            }
            let key = crate::crypto::unwrap_team_key(&wrapped, &team_id, vault_id, epoch, session)?;
            Ok(ResolvedRowKey {
                key,
                epoch: Some(epoch),
                team_id: Some(team_id),
            })
        }
    }
}

pub fn encrypt_row_secret(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    plaintext: &str,
    record_type: &str,
    vault_id: &str,
) -> Result<String, String> {
    let resolved = resolve_row_key(db, session, vault_id, None, true)?;
    match resolved.epoch {
        None => crate::crypto::encrypt_secret(plaintext, record_type, session),
        Some(epoch) => crate::crypto::encrypt_team_secret(
            plaintext,
            record_type,
            vault_id,
            epoch,
            &resolved.key,
            session,
        ),
    }
}

pub fn decrypt_row_secret(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    payload: &str,
    record_type: &str,
    vault_id: &str,
) -> Result<String, String> {
    let header: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "invalid record ciphertext".to_string())?;
    let version = header
        .get("v")
        .and_then(serde_json::Value::as_u64)
        .ok_or("missing ciphertext version")?;
    match version {
        1 => {
            let resolved = resolve_row_key(db, session, vault_id, None, false)?;
            if resolved.epoch.is_some() {
                return Err("personal ciphertext in team vault".into());
            }
            crate::crypto::decrypt_secret(payload, session)
        }
        2 => {
            let epoch = header
                .get("epoch")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or("invalid team key epoch")?;
            let resolved = resolve_row_key(db, session, vault_id, Some(epoch), false)?;
            if resolved.epoch != Some(epoch) {
                return Err("team ciphertext in private vault".into());
            }
            crate::crypto::decrypt_team_secret(
                payload,
                record_type,
                vault_id,
                epoch,
                &resolved.key,
                session,
            )
        }
        _ => Err("unsupported record ciphertext".into()),
    }
}

pub fn rebase_pending_team_rows(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    vault_id: &str,
    device_id: &str,
) -> Result<usize, String> {
    let Some((_, current_epoch, state)) = crate::db::team_vault_meta(db, vault_id)? else {
        return Ok(0);
    };
    if state == "revoked" {
        return Err("team vault access revoked".into());
    }
    if state != "ready" {
        return Ok(0);
    }
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let pending = crate::db::sync_db::pending_team_rows(db, vault_id)?;
    let mut replacements = Vec::new();
    for (table, mut row) in pending {
        let header: serde_json::Value =
            serde_json::from_str(&row.data).map_err(|_| "invalid pending team ciphertext")?;
        let epoch = header
            .get("epoch")
            .and_then(serde_json::Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("pending team row has no key epoch")?;
        if epoch == current_epoch {
            continue;
        }
        if epoch > current_epoch {
            return Err("pending team row has future key epoch".into());
        }
        let plaintext = Zeroizing::new(decrypt_row_secret(
            db,
            session,
            &row.data,
            table.as_str(),
            vault_id,
        )?);
        let data = encrypt_row_secret(db, session, &plaintext, table.as_str(), vault_id)?;
        let previous_operation_id = row.operation_id.clone();
        let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        row.data = data;
        row.operation_id = uuid::Uuid::new_v4().to_string();
        row.device_id = device_id.into();
        row.edited_at = stamp.clone();
        row.updated_at = stamp;
        replacements.push(crate::db::sync_db::RebasedPendingRow {
            table,
            previous_operation_id,
            row,
        });
    }
    let count = replacements.len();
    crate::db::sync_db::replace_pending_team_rows(db, vault_id, &replacements)?;
    Ok(count)
}

#[derive(serde::Serialize)]
pub struct ExportedPendingEdit {
    pub table: String,
    pub id: String,
    pub name: Option<String>,
    pub deleted_at: Option<String>,
    pub plaintext: String,
}

pub fn export_revoked_pending_edits(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    vault_id: &str,
) -> Result<Vec<ExportedPendingEdit>, String> {
    let (_, _, state) = crate::db::team_vault_meta(db, vault_id)?.ok_or("not a team vault")?;
    if state != "revoked" || !session.unlocked {
        return Err("revoked vault must be unlocked for export".into());
    }
    crate::db::sync_db::pending_team_rows(db, vault_id)?
        .into_iter()
        .map(|(table, row)| {
            let plaintext = decrypt_row_secret(db, session, &row.data, table.as_str(), vault_id)?;
            Ok(ExportedPendingEdit {
                table: table.as_str().into(),
                id: row.id,
                name: row.name,
                deleted_at: row.deleted_at,
                plaintext,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use x25519_dalek::PublicKey;

    #[test]
    fn grants_round_trip_without_exposing_raw_key() {
        let owner_db = crate::db::open(":memory:").unwrap();
        let recipient_db = crate::db::open(":memory:").unwrap();
        let mut owner = crate::crypto::KeySession::new();
        let mut recipient = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut owner).unwrap();
        crate::crypto::generate_account_material(&mut recipient).unwrap();
        let public = BASE64.encode(recipient.public_key.as_bytes());
        let recipient_info = RecipientKey {
            user_id: "recipient".into(),
            public_key: public.clone(),
            fingerprint: fingerprint_identity_key(&public).unwrap(),
        };
        let grants =
            create_team_grants(&owner_db, &owner, "team", "vault", &[recipient_info]).unwrap();
        assert_eq!(grants.len(), 1);
        let retry = create_team_grants(
            &owner_db,
            &owner,
            "team",
            "vault",
            &[RecipientKey {
                user_id: "recipient".into(),
                public_key: public.clone(),
                fingerprint: fingerprint_identity_key(&public).unwrap(),
            }],
        )
        .unwrap();
        assert_eq!(
            *open_key_bytes(&grants[0], &recipient.private_key).unwrap(),
            *open_key_bytes(&retry[0], &recipient.private_key).unwrap()
        );
        assert!(serde_json::to_string(&grants)
            .unwrap()
            .contains("ciphertext"));
        import_team_grant(&recipient_db, &recipient, "recipient", &grants[0]).unwrap();
        let from_owner = resolve_row_key(&owner_db, &owner, "vault", None, false).unwrap();
        let from_recipient =
            resolve_row_key(&recipient_db, &recipient, "vault", None, false).unwrap();
        assert_eq!(*from_owner.key, *from_recipient.key);
        assert!(import_team_grant(&recipient_db, &recipient, "wrong-user", &grants[0]).is_err());
    }

    #[test]
    fn row_encryption_uses_team_key_only_for_marked_vault() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let private =
            encrypt_row_secret(&db, &session, "private", "hosts", "private-vault").unwrap();
        assert_eq!(
            decrypt_row_secret(&db, &session, &private, "hosts", "private-vault").unwrap(),
            "private"
        );
        crate::db::store_team_vault_meta(&db, "shared", "team", 1, "ready").unwrap();
        assert!(encrypt_row_secret(&db, &session, "team", "hosts", "shared").is_err());
        let key = [42u8; 32];
        let wrapped = crate::crypto::wrap_team_key(&key, "team", "shared", 1, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, "shared", "team", 1, &wrapped).unwrap();
        let encrypted = encrypt_row_secret(&db, &session, "team", "hosts", "shared").unwrap();
        assert_eq!(
            decrypt_row_secret(&db, &session, &encrypted, "hosts", "shared").unwrap(),
            "team"
        );
        assert!(decrypt_row_secret(&db, &session, &encrypted, "hosts", "private-vault").is_err());
        assert!(decrypt_row_secret(&db, &session, &private, "hosts", "shared").is_err());
    }

    #[test]
    fn resolver_never_falls_back_for_marked_team_vault() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let personal = resolve_row_key(&db, &session, "legacy-team", None, false).unwrap();
        assert_eq!(*personal.key, session.dek);
        assert_eq!(personal.epoch, None);
        crate::db::store_team_vault_meta(&db, "shared", "team", 1, "ready").unwrap();
        assert!(resolve_row_key(&db, &session, "shared", None, false).is_err());
        let team_key = [42u8; 32];
        let wrapped =
            crate::crypto::wrap_team_key(&team_key, "team", "shared", 1, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, "shared", "team", 1, &wrapped).unwrap();
        let resolved = resolve_row_key(&db, &session, "shared", None, true).unwrap();
        assert_eq!(*resolved.key, team_key);
        assert_eq!(resolved.epoch, Some(1));
        crate::db::store_team_vault_meta(&db, "shared", "team", 2, "rotation_required").unwrap();
        assert!(resolve_row_key(&db, &session, "shared", None, true).is_err());
        assert!(resolve_row_key(&db, &session, "shared", None, false).is_err());
    }

    #[test]
    fn sealed_key_round_trip_and_context_tampering() {
        let recipient = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&recipient);
        let fingerprint = fingerprint_identity_key(&base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD_NO_PAD,
            public.as_bytes(),
        ))
        .unwrap();
        let context = GrantContext {
            team_id: "team".into(),
            vault_id: "vault".into(),
            epoch: 1,
            recipient_user_id: "recipient".into(),
            recipient_fingerprint: fingerprint,
        };
        let key = generate_vault_key();
        let envelope = seal_key_bytes(&key, &context, public.as_bytes()).unwrap();
        assert_eq!(*open_key_bytes(&envelope, &recipient).unwrap(), *key);
        assert!(!serde_json::to_string(&envelope)
            .unwrap()
            .contains(&base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD_NO_PAD,
                *key
            )));
        let mut changed = envelope.clone();
        changed.context.vault_id = "other".into();
        assert!(open_key_bytes(&changed, &recipient).is_err());
        let mut changed = envelope.clone();
        changed.context.epoch = 2;
        assert!(open_key_bytes(&changed, &recipient).is_err());
        let mut changed = envelope.clone();
        changed.context.recipient_fingerprint = "wrong".into();
        assert!(open_key_bytes(&changed, &recipient).is_err());
        let wrong = StaticSecret::random_from_rng(rand::rngs::OsRng);
        assert!(open_key_bytes(&envelope, &wrong).is_err());
        assert!(seal_key_bytes(&key, &context, &[0; 32]).is_err());
        let mut changed = envelope.clone();
        changed.ephemeral_public_key = BASE64.encode([0u8; 32]);
        assert!(open_key_bytes(&changed, &recipient).is_err());
        let mut changed = envelope.clone();
        changed.nonce = "invalid".into();
        assert!(open_key_bytes(&changed, &recipient).is_err());
        let mut changed = envelope.clone();
        changed.version = 2;
        assert!(open_key_bytes(&changed, &recipient).is_err());
        assert!(fingerprint_identity_key("broken").is_err());
    }

    #[test]
    fn opens_legacy_termvault_team_envelopes_after_identity_rename() {
        let recipient = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&recipient);
        let public_b64 = BASE64.encode(public.as_bytes());
        let context = GrantContext {
            team_id: "team".into(),
            vault_id: "vault".into(),
            epoch: 1,
            recipient_user_id: "recipient".into(),
            recipient_fingerprint: fingerprint_identity_key(&public_b64).unwrap(),
        };
        let key = generate_vault_key();
        let legacy =
            seal_key_bytes_with_domain(&key, &context, public.as_bytes(), LEGACY_DOMAIN).unwrap();

        assert_eq!(*open_key_bytes(&legacy, &recipient).unwrap(), *key);
    }

    #[test]
    fn queued_old_epoch_edit_is_reencrypted_before_sync() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let team_id = uuid::Uuid::new_v4().to_string();
        let row_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let old_key = generate_vault_key();
        let old_wrapped =
            crate::crypto::wrap_team_key(&old_key, &team_id, &vault_id, 1, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, &vault_id, &team_id, 1, &old_wrapped).unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 1, "ready").unwrap();
        let old_data = crate::crypto::encrypt_team_secret(
            "offline edit",
            "hosts",
            &vault_id,
            1,
            &old_key,
            &session,
        )
        .unwrap();
        crate::db::local_mutate(
            &db,
            crate::db::Table::Hosts,
            &crate::db::SyncRow {
                id: row_id,
                vault_id: vault_id.clone(),
                name: Some("Box".into()),
                data: old_data.clone(),
                ..Default::default()
            },
            &device_id,
        )
        .unwrap();
        let new_key = generate_vault_key();
        let new_wrapped =
            crate::crypto::wrap_team_key(&new_key, &team_id, &vault_id, 2, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, &vault_id, &team_id, 2, &new_wrapped).unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 2, "ready").unwrap();
        assert_eq!(
            rebase_pending_team_rows(&db, &session, &vault_id, &device_id).unwrap(),
            1
        );
        let pending = crate::db::sync_db::pending_batch(&db, &vault_id, 10).unwrap();
        let data = pending[0].record["data"].as_str().unwrap();
        assert_ne!(data, old_data);
        assert_eq!(
            crate::crypto::decrypt_team_secret(data, "hosts", &vault_id, 2, &new_key, &session)
                .unwrap(),
            "offline edit"
        );
        assert_eq!(
            rebase_pending_team_rows(&db, &session, &vault_id, &device_id).unwrap(),
            0
        );
    }

    #[test]
    fn revoked_member_can_export_then_explicitly_discard_queued_edit() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let team_id = uuid::Uuid::new_v4().to_string();
        let row_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let key = generate_vault_key();
        let wrapped = crate::crypto::wrap_team_key(&key, &team_id, &vault_id, 1, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, &vault_id, &team_id, 1, &wrapped).unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 1, "ready").unwrap();
        let data = encrypt_row_secret(&db, &session, "offline secret", "hosts", &vault_id).unwrap();
        crate::db::local_mutate(
            &db,
            crate::db::Table::Hosts,
            &crate::db::SyncRow {
                id: row_id.clone(),
                vault_id: vault_id.clone(),
                name: Some("Box".into()),
                data,
                ..Default::default()
            },
            &device_id,
        )
        .unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 1, "revoked").unwrap();
        assert!(encrypt_row_secret(&db, &session, "new", "hosts", &vault_id).is_err());
        let exported = export_revoked_pending_edits(&db, &session, &vault_id).unwrap();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].plaintext, "offline secret");
        assert_eq!(
            crate::db::sync_db::list_revoked_pending_edits(&db).unwrap()[0].pending,
            1
        );
        assert_eq!(
            crate::db::sync_db::pending_count(&db, &vault_id).unwrap(),
            1
        );
        assert_eq!(
            crate::db::sync_db::discard_revoked_pending_edits(&db, &vault_id).unwrap(),
            1
        );
        assert_eq!(
            crate::db::sync_db::pending_count(&db, &vault_id).unwrap(),
            0
        );
        assert!(
            crate::db::get_sync_row(&db, crate::db::Table::Hosts, &row_id)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn stale_key_fetch_cannot_reopen_revoked_vault() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let team_id = uuid::Uuid::new_v4().to_string();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let user_id = uuid::Uuid::new_v4().to_string();
        let public = PublicKey::from(&session.private_key);
        let key = generate_vault_key();
        let envelope = seal_key_bytes(
            &key,
            &GrantContext {
                team_id: team_id.clone(),
                vault_id: vault_id.clone(),
                epoch: 1,
                recipient_user_id: user_id.clone(),
                recipient_fingerprint: fingerprint_identity_key(&BASE64.encode(public.as_bytes()))
                    .unwrap(),
            },
            public.as_bytes(),
        )
        .unwrap();
        import_team_grant(&db, &session, &user_id, &envelope).unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 1, "revoked").unwrap();
        assert!(import_team_grant(&db, &session, &user_id, &envelope).is_err());
        assert_eq!(
            crate::db::team_vault_meta(&db, &vault_id)
                .unwrap()
                .unwrap()
                .2,
            "revoked"
        );
    }

    #[test]
    fn prepare_rotation_reencrypts_without_exposing_plaintext() {
        let db = crate::db::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let team_id = uuid::Uuid::new_v4().to_string();
        let row_id = uuid::Uuid::new_v4().to_string();
        let old_key = generate_vault_key();
        let wrapped =
            crate::crypto::wrap_team_key(&old_key, &team_id, &vault_id, 1, &session).unwrap();
        crate::db::store_wrapped_team_key(&db, &vault_id, &team_id, 1, &wrapped).unwrap();
        crate::db::store_team_vault_meta(&db, &vault_id, &team_id, 1, "rotation_required").unwrap();
        let old_data =
            crate::crypto::encrypt_team_secret("secret", "hosts", &vault_id, 1, &old_key, &session)
                .unwrap();
        let public = BASE64.encode(PublicKey::from(&session.private_key).as_bytes());
        let recipient = RecipientKey {
            user_id: uuid::Uuid::new_v4().to_string(),
            fingerprint: fingerprint_identity_key(&public).unwrap(),
            public_key: public,
        };
        let prepared = prepare_rotation(
            &db,
            &session,
            &team_id,
            &vault_id,
            1,
            4,
            vec![RotationRow {
                table: "hosts".into(),
                id: row_id,
                revision: 1,
                data: old_data.clone(),
            }],
            vec![recipient],
        )
        .unwrap();
        assert_eq!(prepared.rows.len(), 1);
        assert_ne!(prepared.rows[0].data, old_data);
        assert!(!serde_json::to_string(&prepared).unwrap().contains("secret"));
        let new_key = open_key_bytes(&prepared.envelopes[0], &session.private_key).unwrap();
        assert_eq!(
            crate::crypto::decrypt_team_secret(
                &prepared.rows[0].data,
                "hosts",
                &vault_id,
                2,
                &new_key,
                &session
            )
            .unwrap(),
            "secret"
        );
        assert!(
            prepare_rotation(&db, &session, &team_id, &vault_id, 2, 4, vec![], vec![]).is_err()
        );
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RotationRow {
    pub table: String,
    pub id: String,
    pub revision: u32,
    pub data: String,
}

#[derive(Debug, serde::Serialize)]
pub struct PreparedRotation {
    pub operation_id: String,
    pub expected_epoch: u32,
    pub expected_revision: u32,
    pub rows: Vec<RotationRow>,
    pub envelopes: Vec<TeamKeyEnvelope>,
}

pub fn prepare_rotation(
    db: &crate::db::LocalDb,
    session: &crate::crypto::KeySession,
    team_id: &str,
    vault_id: &str,
    expected_epoch: u32,
    expected_revision: u32,
    rows: Vec<RotationRow>,
    recipients: Vec<RecipientKey>,
) -> Result<PreparedRotation, String> {
    let (stored_team, local_epoch, state) =
        crate::db::team_vault_meta(db, vault_id)?.ok_or("not a team vault")?;
    if stored_team != team_id
        || local_epoch != expected_epoch
        || state != "rotation_required"
        || expected_revision == 0
        || recipients.is_empty()
    {
        return Err("team rotation context changed".into());
    }
    let new_key = generate_vault_key();
    let new_epoch = expected_epoch.checked_add(1).ok_or("key epoch overflow")?;
    let mut encrypted_rows = Vec::with_capacity(rows.len());
    let mut seen_rows = std::collections::HashSet::new();
    for row in rows {
        let table = crate::db::Table::parse(&row.table)?;
        if table == crate::db::Table::Vaults
            || uuid::Uuid::parse_str(&row.id).is_err()
            || row.revision == 0
            || !seen_rows.insert((row.table.clone(), row.id.clone()))
        {
            return Err("invalid rotation row".into());
        }
        let plaintext = decrypt_row_secret(db, session, &row.data, table.as_str(), vault_id)?;
        let data = crate::crypto::encrypt_team_secret(
            &plaintext,
            table.as_str(),
            vault_id,
            new_epoch,
            &new_key,
            session,
        )?;
        encrypted_rows.push(RotationRow { data, ..row });
    }
    let mut envelopes = Vec::with_capacity(recipients.len());
    let mut seen_recipients = std::collections::HashSet::new();
    for recipient in recipients {
        if !seen_recipients.insert(recipient.user_id.clone()) || recipient.user_id.is_empty() {
            return Err("duplicate team key recipient".into());
        }
        let bytes = BASE64
            .decode(&recipient.public_key)
            .map_err(|_| "invalid recipient key")?;
        let public: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "invalid recipient key length")?;
        let context = GrantContext {
            team_id: team_id.into(),
            vault_id: vault_id.into(),
            epoch: new_epoch,
            recipient_user_id: recipient.user_id,
            recipient_fingerprint: recipient.fingerprint,
        };
        envelopes.push(seal_key_bytes(&new_key, &context, &public)?);
    }
    Ok(PreparedRotation {
        operation_id: uuid::Uuid::new_v4().to_string(),
        expected_epoch,
        expected_revision,
        rows: encrypted_rows,
        envelopes,
    })
}
