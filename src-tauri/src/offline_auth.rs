use crate::db::LocalDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

const KEY_TYPE: &str = "offline_identity";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OfflineProfile {
    pub id: String,
    pub email: String,
    pub full_name: Option<String>,
    pub initialized: bool,
    pub auth_provider: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WrappedKeyring {
    pub dek_wrapped_by_kek: String,
    pub dek_wrapped_by_recovery: String,
    pub private_key_wrapped_by_dek: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OfflineIdentity {
    pub profile: OfflineProfile,
    pub salt_cl: String,
    pub wrapped_keyring: WrappedKeyring,
}

pub fn save_offline_identity(db: &LocalDb, identity: &OfflineIdentity) -> Result<(), String> {
    if identity.profile.id.is_empty()
        || identity.profile.email.is_empty()
        || identity.salt_cl.is_empty()
        || identity.wrapped_keyring.dek_wrapped_by_kek.is_empty()
    {
        return Err("Incomplete offline identity".into());
    }
    let mut identity = identity.clone();
    identity.profile.created_at = crate::db::canonical_utc_millis(&identity.profile.created_at)?;
    let payload = serde_json::to_string(&identity).map_err(|e| e.to_string())?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT user_id FROM user_keys WHERE key_type = ?1 LIMIT 1",
            [KEY_TYPE],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing
        .as_deref()
        .is_some_and(|id| id != identity.profile.id)
    {
        return Err(
            "Another account is enrolled on this device. Sign out before switching accounts."
                .into(),
        );
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    tx.execute(
        "INSERT INTO user_profiles (id, email, name, auth_provider, salt_cl, initialized, created_at, updated_at, last_login_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name,
         auth_provider=excluded.auth_provider, salt_cl=excluded.salt_cl,
         initialized=excluded.initialized, updated_at=excluded.updated_at, last_login_at=excluded.last_login_at",
        params![identity.profile.id, identity.profile.email, identity.profile.full_name.clone().unwrap_or_default(),
            identity.profile.auth_provider, identity.salt_cl, identity.profile.initialized as i32,
            identity.profile.created_at, now],
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO user_keys (user_id, key_type, payload, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, key_type) DO UPDATE SET payload=excluded.payload",
        params![identity.profile.id, KEY_TYPE, payload, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn load_offline_identity(db: &LocalDb) -> Result<Option<OfflineIdentity>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM user_keys WHERE key_type = ?1 LIMIT 1",
            [KEY_TYPE],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    payload
        .map(|p| serde_json::from_str(&p).map_err(|e| e.to_string()))
        .transpose()
}

pub fn clear_offline_identity(db: &LocalDb) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM user_keys WHERE key_type = ?1", [KEY_TYPE])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_offline_identity_command(
    db: tauri::State<'_, LocalDb>,
    identity: OfflineIdentity,
) -> Result<(), String> {
    save_offline_identity(&db, &identity)
}

#[tauri::command]
pub fn load_offline_identity_command(
    db: tauri::State<'_, LocalDb>,
) -> Result<Option<OfflineIdentity>, String> {
    load_offline_identity(&db)
}

#[tauri::command]
pub fn clear_offline_identity_command(db: tauri::State<'_, LocalDb>) -> Result<(), String> {
    clear_offline_identity(&db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_auth_stores_only_wrapped_material_and_rejects_account_switch() {
        let db = crate::db::open(":memory:").unwrap();
        let identity = OfflineIdentity {
            profile: OfflineProfile {
                id: "u1".into(),
                email: "a@example.com".into(),
                full_name: None,
                initialized: true,
                auth_provider: "password".into(),
                created_at: "2026-09-27T00:00:00.000Z".into(),
            },
            salt_cl: "salt".into(),
            wrapped_keyring: WrappedKeyring {
                dek_wrapped_by_kek: "wrapped".into(),
                dek_wrapped_by_recovery: "recovery-wrapped".into(),
                private_key_wrapped_by_dek: "private-wrapped".into(),
            },
        };
        save_offline_identity(&db, &identity).unwrap();
        assert_eq!(load_offline_identity(&db).unwrap(), Some(identity.clone()));
        let mut other = identity.clone();
        other.profile.id = "u2".into();
        assert!(save_offline_identity(&db, &other).is_err());
        assert_eq!(load_offline_identity(&db).unwrap(), Some(identity));
        clear_offline_identity(&db).unwrap();
        assert!(load_offline_identity(&db).unwrap().is_none());
    }
}
