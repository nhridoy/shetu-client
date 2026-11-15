//! Identity reads and writes stay in Rust: passwords and TOTP secrets never reach the webview.

use crate::db::{self, LocalDb, SyncRow, Table};
use crate::CryptoState;
use serde_json::{Map, Value};

const FIELDS: [&str; 4] = ["username", "password", "keyId", "totpSecret"];

/// What the edit form may see of a saved identity.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityView {
    pub username: String,
    pub key_id: Option<String>,
    pub has_password: bool,
    pub has_totp: bool,
}

/// Ciphertext of an identity row (personal `aad` or team `record_type`).
pub fn is_identity_ciphertext(header: &Value) -> bool {
    use base64::Engine;
    let aad = base64::engine::general_purpose::STANDARD_NO_PAD.encode("identities");
    header["record_type"] == "identities"
        || header["aad"].as_str().map(|a| a.trim_end_matches('=')) == Some(aad.as_str())
}

fn live_payload(
    db: &LocalDb,
    crypto: &CryptoState,
    id: &str,
) -> Option<(SyncRow, Map<String, Value>)> {
    let row = db::get_sync_row(db, Table::Identities, id)
        .ok()
        .flatten()
        .filter(|r| r.deleted_at.is_none())?;
    let session = crypto.session.lock().ok()?;
    let plain =
        crate::team_keys::decrypt_row_secret(db, &session, &row.data, "identities", &row.vault_id)
            .ok()?;
    let payload = serde_json::from_str::<Value>(&plain)
        .ok()?
        .as_object()?
        .clone();
    Some((row, payload))
}

pub fn view(db: &LocalDb, crypto: &CryptoState, id: &str) -> Option<IdentityView> {
    let (_, p) = live_payload(db, crypto, id)?;
    let text = |k: &str| {
        p.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    Some(IdentityView {
        username: text("username").unwrap_or_default(),
        key_id: text("keyId"),
        has_password: text("password").is_some(),
        has_totp: text("totpSecret").is_some(),
    })
}

/// Create (`id` None) or merge-update. Patch per field: absent or `""` keeps, `null` clears, text sets.
pub fn save(
    db: &LocalDb,
    crypto: &CryptoState,
    id: Option<&str>,
    vault_id: &str,
    name: &str,
    patch: &Value,
    device_id: &str,
) -> Result<SyncRow, String> {
    let (mut row, mut payload) = match id {
        Some(id) => live_payload(db, crypto, id).ok_or("Identity not found")?,
        None => (
            SyncRow {
                id: uuid::Uuid::new_v4().to_string(),
                vault_id: vault_id.to_string(),
                ..Default::default()
            },
            Map::new(),
        ),
    };
    for key in FIELDS {
        match patch.get(key) {
            Some(Value::Null) => {
                payload.remove(key);
            }
            Some(Value::String(v)) if !v.is_empty() => {
                payload.insert(key.into(), Value::String(v.clone()));
            }
            _ => {}
        }
    }
    if payload
        .get("username")
        .and_then(Value::as_str)
        .is_none_or(|u| u.trim().is_empty())
    {
        return Err("Username is required".into());
    }
    row.name = Some(name.to_string());
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    row.data = crate::team_keys::encrypt_row_secret(
        db,
        &session,
        &Value::Object(payload).to_string(),
        "identities",
        &row.vault_id,
    )?;
    drop(session);
    db::local_mutate(db, Table::Identities, &row, device_id)
}

#[tauri::command]
pub fn identity_view(
    id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Option<IdentityView> {
    view(&db, &crypto, &id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn identity_save(
    id: Option<String>,
    vault_id: String,
    name: String,
    patch: Value,
    device_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<SyncRow, String> {
    save(
        &db,
        &crypto,
        id.as_deref(),
        &vault_id,
        &name,
        &patch,
        &device_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto, db, CryptoState};
    use serde_json::json;
    use std::sync::Mutex;

    const DEVICE: &str = "6f1c1b2e-6b7a-4c1e-9a65-1f2a3b4c5d6e";

    fn fixture() -> (db::LocalDb, CryptoState) {
        let mut keys = crypto::KeySession::new();
        crypto::generate_account_material(&mut keys).unwrap();
        (
            db::open(":memory:").unwrap(),
            CryptoState {
                session: Mutex::new(keys),
            },
        )
    }

    #[test]
    fn save_creates_then_merges() {
        let (db, crypto) = fixture();
        let row = save(
            &db,
            &crypto,
            None,
            "v1",
            "deploy@prod",
            &json!({"username": "deploy", "password": "pw", "totpSecret": "GEZDGNBV"}),
            DEVICE,
        )
        .unwrap();
        assert_eq!(
            (row.vault_id.as_str(), row.name.as_deref()),
            ("v1", Some("deploy@prod"))
        );
        assert!(!row.data.contains("pw"));
        save(
            &db,
            &crypto,
            Some(&row.id),
            "ignored",
            "ops",
            &json!({"username": "ops", "password": "", "totpSecret": null}),
            DEVICE,
        )
        .unwrap();
        let v = view(&db, &crypto, &row.id).unwrap();
        assert_eq!(
            (
                v.username.as_str(),
                v.key_id.as_deref(),
                v.has_password,
                v.has_totp
            ),
            ("ops", None, true, false)
        );
        let text = serde_json::to_string(&v).unwrap();
        assert!(!text.contains("pw") && !text.contains("GEZDGNBV"), "{text}");
        let saved = db::get_sync_row(&db, db::Table::Identities, &row.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            (saved.vault_id.as_str(), saved.name.as_deref()),
            ("v1", Some("ops"))
        );
    }

    #[test]
    fn save_requires_a_username_and_a_live_row() {
        let (db, crypto) = fixture();
        assert!(save(
            &db,
            &crypto,
            None,
            "v1",
            "x",
            &json!({"password": "pw"}),
            DEVICE
        )
        .is_err());
        let row = save(
            &db,
            &crypto,
            None,
            "v1",
            "x",
            &json!({"username": "u"}),
            DEVICE,
        )
        .unwrap();
        assert!(save(
            &db,
            &crypto,
            Some(&row.id),
            "v1",
            "x",
            &json!({"username": null}),
            DEVICE
        )
        .is_err());
        db::tombstone_sync_row(&db, db::Table::Identities, &row.id).unwrap();
        assert!(save(
            &db,
            &crypto,
            Some(&row.id),
            "v1",
            "x",
            &json!({"username": "u"}),
            DEVICE
        )
        .is_err());
        assert!(view(&db, &crypto, &row.id).is_none());
    }

    #[test]
    fn identity_ciphertext_is_recognised() {
        let (_db, crypto) = fixture();
        let session = crypto.session.lock().unwrap();
        let header = |rt: &str| {
            serde_json::from_str::<serde_json::Value>(
                &crypto::encrypt_secret("{}", rt, &session).unwrap(),
            )
            .unwrap()
        };
        assert!(is_identity_ciphertext(&header("identities")));
        assert!(!is_identity_ciphertext(&header("hosts")));
        assert!(is_identity_ciphertext(
            &json!({"v": 2, "record_type": "identities"})
        ));
        assert!(!is_identity_ciphertext(
            &json!({"v": 2, "record_type": "keys"})
        ));
    }
}
