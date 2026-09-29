use super::model::{validate, ForwardDefinition, ForwardInput, ForwardMode};
use crate::crypto::{self, KeySession};
use crate::db::{self, LocalDb, SyncRow, Table};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretFields {
    local_port: Option<u16>,
    remote_bind_address: Option<String>,
    remote_port: Option<u16>,
    destination_host: Option<String>,
    destination_port: Option<u16>,
}

impl From<&ForwardInput> for SecretFields {
    fn from(input: &ForwardInput) -> Self {
        Self {
            local_port: input.local_port,
            remote_bind_address: input.remote_bind_address.clone(),
            remote_port: input.remote_port,
            destination_host: input.destination_host.clone(),
            destination_port: input.destination_port,
        }
    }
}

fn encode_secret(input: &ForwardInput, session: &KeySession) -> Result<String, String> {
    let plaintext = serde_json::to_string(&SecretFields::from(input)).map_err(|e| e.to_string())?;
    crypto::encrypt_secret(&plaintext, Table::PortForwards.as_str(), session)
}

fn definition(row: &SyncRow, session: &KeySession) -> Result<ForwardDefinition, String> {
    let plaintext = crypto::decrypt_secret(&row.data, session)?;
    let secret: SecretFields =
        serde_json::from_str(&plaintext).map_err(|e| format!("Invalid saved forward: {e}"))?;
    let mode = ForwardMode::parse(row.mode.as_deref().ok_or("Forward mode missing")?)?;
    Ok(ForwardDefinition {
        id: row.id.clone(),
        host_id: row.host_id.clone().ok_or("Forward host missing")?,
        mode,
        name: row.name.clone().unwrap_or_default(),
        local_port: secret.local_port,
        remote_bind_address: secret.remote_bind_address,
        remote_port: secret.remote_port,
        destination_host: secret.destination_host,
        destination_port: secret.destination_port,
    })
}

fn live_host(db: &LocalDb, id: &str) -> Result<SyncRow, String> {
    let host = db::get_sync_row(db, Table::Hosts, id)?.ok_or("Saved host does not exist")?;
    if host.deleted_at.is_some() {
        return Err("Saved host does not exist".into());
    }
    Ok(host)
}

/// Convert old plaintext rows only after the account key has been unlocked.
/// The stable IDs survive; all newly uploaded rows contain only ciphertext.
pub fn migrate_legacy(db: &LocalDb, session: &KeySession, device_id: &str) -> Result<(), String> {
    let legacy = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT p.id, p.host_id, p.mode, p.name, p.local_port, p.remote_bind_address, \
             p.remote_port, p.destination_host, p.destination_port, h.vault_id \
             FROM port_forwards p JOIN hosts h ON h.id = p.host_id \
             WHERE p.deleted_at IS NULL AND h.deleted_at IS NULL AND (p.data = '{}' OR p.data = '')"
        ).map_err(|e| format!("read legacy forwards: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<u16>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<u16>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<u16>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (
        id,
        host_id,
        mode,
        name,
        local_port,
        remote_bind_address,
        remote_port,
        destination_host,
        destination_port,
        vault_id,
    ) in legacy
    {
        let input = ForwardInput {
            host_id: host_id.clone(),
            mode: ForwardMode::parse(&mode)?,
            name: name.clone(),
            local_port,
            remote_bind_address,
            remote_port,
            destination_host,
            destination_port,
        };
        validate(&input)?;
        let row = SyncRow {
            id,
            vault_id,
            host_id: Some(host_id),
            mode: Some(mode),
            name: Some(name),
            data: encode_secret(&input, session)?,
            ..Default::default()
        };
        db::local_mutate(db, Table::PortForwards, &row, device_id)?;
    }
    // Also finish a prior interrupted migration after its encrypted upsert committed.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE port_forwards SET local_port=NULL, remote_bind_address=NULL, remote_port=NULL, \
                  destination_host=NULL, destination_port=NULL WHERE data NOT IN ('{}', '') \
                  AND (local_port IS NOT NULL OR remote_bind_address IS NOT NULL OR remote_port IS NOT NULL \
                  OR destination_host IS NOT NULL OR destination_port IS NOT NULL)", [])
        .map_err(|e| format!("clear legacy forward secrets: {e}"))?;
    Ok(())
}

pub fn get(
    db: &LocalDb,
    session: &KeySession,
    device_id: &str,
    id: &str,
) -> Result<ForwardDefinition, String> {
    migrate_legacy(db, session, device_id)?;
    let row = db::get_sync_row(db, Table::PortForwards, id)?
        .ok_or("Saved port forward does not exist")?;
    if row.deleted_at.is_some() {
        return Err("Saved port forward does not exist".into());
    }
    live_host(db, row.host_id.as_deref().ok_or("Forward host missing")?)?;
    definition(&row, session)
}

pub fn list(
    db: &LocalDb,
    session: &KeySession,
    device_id: &str,
    host_id: &str,
) -> Result<Vec<ForwardDefinition>, String> {
    migrate_legacy(db, session, device_id)?;
    let host = match live_host(db, host_id) {
        Ok(host) => host,
        Err(_) => return Ok(Vec::new()),
    };
    db::list_sync_rows(db, Table::PortForwards, &host.vault_id, false)?
        .into_iter()
        .filter(|row| row.host_id.as_deref() == Some(host_id))
        .map(|row| definition(&row, session))
        .collect()
}

pub fn create(
    db: &LocalDb,
    session: &KeySession,
    device_id: &str,
    input: ForwardInput,
) -> Result<ForwardDefinition, String> {
    validate(&input)?;
    migrate_legacy(db, session, device_id)?;
    let host = live_host(db, &input.host_id)?;
    let row = SyncRow {
        id: uuid::Uuid::new_v4().to_string(),
        vault_id: host.vault_id,
        host_id: Some(input.host_id.clone()),
        mode: Some(input.mode.as_str().into()),
        name: Some(input.name.clone()),
        data: encode_secret(&input, session)?,
        ..Default::default()
    };
    let saved = db::local_mutate(db, Table::PortForwards, &row, device_id)?;
    definition(&saved, session)
}

pub fn update(
    db: &LocalDb,
    session: &KeySession,
    device_id: &str,
    id: &str,
    input: ForwardInput,
) -> Result<ForwardDefinition, String> {
    validate(&input)?;
    migrate_legacy(db, session, device_id)?;
    let mut row = db::get_sync_row(db, Table::PortForwards, id)?.ok_or("Forward does not exist")?;
    if row.deleted_at.is_some() || row.host_id.as_deref() != Some(input.host_id.as_str()) {
        return Err("Forward or saved host does not exist".into());
    }
    live_host(db, &input.host_id)?;
    row.mode = Some(input.mode.as_str().into());
    row.name = Some(input.name.clone());
    row.data = encode_secret(&input, session)?;
    let saved = db::local_mutate(db, Table::PortForwards, &row, device_id)?;
    definition(&saved, session)
}

pub fn delete(db: &LocalDb, session: &KeySession, device_id: &str, id: &str) -> Result<(), String> {
    migrate_legacy(db, session, device_id)?;
    db::tombstone_sync_row_with_device(db, Table::PortForwards, id, device_id)
}

pub fn delete_for_host(db: &LocalDb, host_id: &str, device_id: &str) -> Result<(), String> {
    let host = match db::get_sync_row(db, Table::Hosts, host_id)? {
        Some(host) => host,
        None => return Ok(()),
    };
    let rows = db::list_sync_rows(db, Table::PortForwards, &host.vault_id, false)?;
    for row in rows
        .into_iter()
        .filter(|row| row.host_id.as_deref() == Some(host_id))
    {
        db::tombstone_sync_row_with_device(db, Table::PortForwards, &row.id, device_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forwarding::model::ForwardInput;

    #[test]
    fn sync_forward_definition_encrypts_sensitive_fields_and_queues_without_runtime() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let saved = create(
            &db,
            &session,
            DEVICE,
            ForwardInput::local("h1", "web", 8080, "internal.example", 80),
        )
        .unwrap();
        let row = crate::db::get_sync_row(&db, crate::db::Table::PortForwards, &saved.id)
            .unwrap()
            .unwrap();
        assert_eq!(row.vault_id, "v1");
        assert!(!row.data.contains("internal.example"));
        assert!(!row.data.contains("8080"));
        assert_eq!(list(&db, &session, DEVICE, "h1").unwrap()[0], saved);
        let pending = crate::db::outbox_pending(&db).unwrap();
        assert!(pending
            .iter()
            .any(|entry| entry.table_name == "port_forwards" && entry.record_id == saved.id));
        let state = crate::forwarding::runtime::ForwardingState::new();
        assert_eq!(
            state.status(&saved.id),
            crate::forwarding::model::ForwardStatus::Stopped
        );
    }

    #[test]
    fn remote_definition_is_stopped_and_does_not_enter_outbox() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let host_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO hosts (id, vault_id, created_at, updated_at, name) VALUES (?1, ?2, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z', 'host')", rusqlite::params![host_id, vault_id]).unwrap();
        let session = session();
        let input = ForwardInput::dynamic(&host_id, "remote socks", 1080);
        let row = SyncRow {
            id: uuid::Uuid::new_v4().to_string(),
            vault_id: vault_id.clone(),
            host_id: Some(host_id.clone()),
            mode: Some("dynamic".into()),
            name: Some(input.name.clone()),
            data: encode_secret(&input, &session).unwrap(),
            created_at: "2026-09-27T00:00:00.000Z".into(),
            updated_at: "2026-09-27T00:00:00.000Z".into(),
            edited_at: "2026-09-27T00:00:00.000Z".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        };
        crate::db::sync_db::apply_pull_page(
            &db,
            &vault_id,
            &[crate::db::sync_db::PullChange {
                cursor: 1,
                table: "port_forwards".into(),
                record: serde_json::json!({
                    "id": row.id, "vault_id": row.vault_id, "revision": row.revision,
                    "host_id": row.host_id, "mode": row.mode, "name": row.name,
                    "sort_order": row.sort_order, "data": row.data,
                    "created_at": row.created_at, "updated_at": row.updated_at,
                    "deleted_at": row.deleted_at, "edited_at": row.edited_at,
                    "device_id": row.device_id, "operation_id": row.operation_id,
                }),
            }],
            1,
        )
        .unwrap();
        assert_eq!(list(&db, &session, DEVICE, &host_id).unwrap()[0].id, row.id);
        assert_eq!(
            crate::forwarding::runtime::ForwardingState::new().status(&row.id),
            crate::forwarding::model::ForwardStatus::Stopped
        );
        assert!(crate::db::outbox_pending(&db).unwrap().is_empty());
    }

    #[test]
    fn legacy_migration_waits_for_unlocked_key() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        db.conn.lock().unwrap().execute("INSERT INTO port_forwards (id, host_id, mode, name, local_port) VALUES ('old', 'h1', 'dynamic', 'socks', 1080)", []).unwrap();
        let locked = crate::crypto::KeySession::new();
        assert_eq!(
            migrate_legacy(&db, &locked, DEVICE).unwrap_err(),
            "Vault is locked"
        );
        let row = crate::db::get_sync_row(&db, Table::PortForwards, "old")
            .unwrap()
            .unwrap();
        assert_eq!(row.data, "{}");
        assert!(crate::db::outbox_pending(&db).unwrap().is_empty());
    }

    #[test]
    fn sync_forward_migrates_legacy_row_with_same_id() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO port_forwards (id, host_id, mode, name, local_port, destination_host, destination_port) VALUES ('old', 'h1', 'local', 'legacy', 9000, 'localhost', 22)", []).unwrap();
        }
        migrate_legacy(&db, &session, DEVICE).unwrap();
        let first_operation = crate::db::get_sync_row(&db, Table::PortForwards, "old")
            .unwrap()
            .unwrap()
            .operation_id;
        migrate_legacy(&db, &session, DEVICE).unwrap();
        assert_eq!(
            crate::db::get_sync_row(&db, Table::PortForwards, "old")
                .unwrap()
                .unwrap()
                .operation_id,
            first_operation
        );
        assert_eq!(
            get(&db, &session, DEVICE, "old").unwrap().local_port,
            Some(9000)
        );
        let conn = db.conn.lock().unwrap();
        let (legacy_host, data): (Option<String>, String) = conn
            .query_row(
                "SELECT destination_host, data FROM port_forwards WHERE id = 'old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(legacy_host.is_none());
        assert!(!data.contains("localhost"));
    }

    const DEVICE: &str = "00000000-0000-4000-8000-000000000001";

    fn host(db: &crate::db::LocalDb, id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO hosts (id, vault_id, created_at, updated_at, name) VALUES (?1, 'v1', 1, 1, 'host')", [id]).unwrap();
    }

    fn session() -> crate::crypto::KeySession {
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        session
    }

    #[test]
    fn create_update_delete_round_trip() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let session = session();
        let saved = create(
            &db,
            &session,
            DEVICE,
            ForwardInput::local("h1", "web", 8080, "localhost", 80),
        )
        .unwrap();
        assert_eq!(list(&db, &session, DEVICE, "h1").unwrap()[0].id, saved.id);
        assert_eq!(get(&db, &session, DEVICE, &saved.id).unwrap(), saved);
        let edited = update(
            &db,
            &session,
            DEVICE,
            &saved.id,
            ForwardInput::dynamic("h1", "socks", 1080),
        )
        .unwrap();
        assert_eq!(edited.id, saved.id);
        assert_eq!(list(&db, &session, DEVICE, "h1").unwrap()[0].name, "socks");
        delete(&db, &session, DEVICE, &saved.id).unwrap();
        assert!(get(&db, &session, DEVICE, &saved.id).is_err());
        assert!(list(&db, &session, DEVICE, "h1").unwrap().is_empty());
        let tombstone = crate::db::get_sync_row(&db, Table::PortForwards, &saved.id)
            .unwrap()
            .unwrap();
        assert!(tombstone.deleted_at.is_some());
    }

    #[test]
    fn deleted_host_hides_forward_without_erasing_its_sync_record() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let session = session();
        let saved = create(
            &db,
            &session,
            DEVICE,
            ForwardInput::dynamic("h1", "socks", 1080),
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE hosts SET deleted_at = '2026-09-27T00:00:00.000Z' WHERE id = 'h1'",
                [],
            )
            .unwrap();
        assert!(list(&db, &session, DEVICE, "h1").unwrap().is_empty());
        assert!(crate::db::get_sync_row(&db, Table::PortForwards, &saved.id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn rejects_unknown_hosts_and_tombstones_all_for_host() {
        let db = crate::db::open(":memory:").unwrap();
        let session = session();
        assert!(create(
            &db,
            &session,
            DEVICE,
            ForwardInput::dynamic("absent", "socks", 1080)
        )
        .is_err());
        host(&db, "h1");
        let first = create(
            &db,
            &session,
            DEVICE,
            ForwardInput::dynamic("h1", "first", 1080),
        )
        .unwrap();
        let second = create(
            &db,
            &session,
            DEVICE,
            ForwardInput::dynamic("h1", "second", 1081),
        )
        .unwrap();
        delete_for_host(&db, "h1", DEVICE).unwrap();
        assert!(list(&db, &session, DEVICE, "h1").unwrap().is_empty());
        for id in [first.id, second.id] {
            assert!(crate::db::get_sync_row(&db, Table::PortForwards, &id)
                .unwrap()
                .unwrap()
                .deleted_at
                .is_some());
        }
    }

    #[test]
    fn wipe_removes_saved_forwards() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let session = session();
        create(
            &db,
            &session,
            DEVICE,
            ForwardInput::local("h1", "web", 8080, "localhost", 80),
        )
        .unwrap();
        crate::db::wipe_all(&db).unwrap();
        assert!(list(&db, &session, DEVICE, "h1").unwrap().is_empty());
    }
}
