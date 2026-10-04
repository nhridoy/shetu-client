use crate::crypto::{self, KeySession};
use crate::db::{self, LocalDb, SyncRow, Table};
use chrono::{Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub vault_id: String,
    pub origin_device_id: String,
    pub host_id: String,
    pub host_label: String,
    pub connection_type: String,
    pub state: String,
    pub started_at: String,
    pub connected_at: Option<String>,
    pub ended_at: Option<String>,
    pub reason: Option<String>,
    pub recording: bool,
    pub truncated: bool,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

const OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
const OUTPUT_LIMIT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Default)]
pub struct OutputBuffer {
    pending: String,
    recorded_bytes: usize,
    next_seq: i64,
    truncated: bool,
}

impl OutputBuffer {
    pub fn push(&mut self, text: &str) -> Vec<String> {
        let allowance = OUTPUT_LIMIT_BYTES.saturating_sub(self.recorded_bytes);
        let mut accepted = text.len().min(allowance);
        while accepted > 0 && !text.is_char_boundary(accepted) {
            accepted -= 1;
        }
        self.truncated |= accepted < text.len();
        let mut completed = Vec::new();
        let mut offset = 0;
        while offset < accepted {
            let room = OUTPUT_CHUNK_BYTES - self.pending.len();
            let mut take = (accepted - offset).min(room);
            while take > 0 && !text.is_char_boundary(offset + take) {
                take -= 1;
            }
            if take == 0 {
                completed.push(std::mem::take(&mut self.pending));
                continue;
            }
            self.pending.push_str(&text[offset..offset + take]);
            offset += take;
            self.recorded_bytes += take;
            if self.pending.len() == OUTPUT_CHUNK_BYTES {
                completed.push(std::mem::take(&mut self.pending));
            }
        }
        completed
    }

    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}

fn decode(row: &SyncRow, keys: &KeySession) -> Result<HistoryItem, String> {
    let plaintext = crypto::decrypt_secret(&row.data, keys)?;
    serde_json::from_str(&plaintext).map_err(|e| e.to_string())
}

fn save(db: &LocalDb, keys: &KeySession, device_id: &str, item: &HistoryItem) -> Result<(), String> {
    let plaintext = serde_json::to_string(item).map_err(|e| e.to_string())?;
    let data = crypto::encrypt_secret(&plaintext, Table::SessionHistory.as_str(), keys)?;
    let row = SyncRow {
        id: item.id.clone(),
        vault_id: item.vault_id.clone(),
        name: Some("Session".into()),
        data,
        ..SyncRow::default()
    };
    db::local_mutate(db, Table::SessionHistory, &row, device_id)?;
    Ok(())
}

pub fn start_attempt(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
    attempt_id: &str,
    host_id: &str,
    host_label: &str,
    connection_type: &str,
    recording: bool,
) -> Result<(), String> {
    uuid::Uuid::parse_str(attempt_id).map_err(|_| "invalid attempt ID")?;
    if !matches!(connection_type, "ssh" | "local") {
        return Err("invalid connection type".into());
    }
    if db::get_sync_row(db, Table::SessionHistory, attempt_id)?.is_some() {
        return Err("attempt already exists".into());
    }
    let item = HistoryItem {
        id: attempt_id.into(),
        vault_id: vault_id.into(),
        origin_device_id: device_id.into(),
        host_id: host_id.into(),
        host_label: host_label.into(),
        connection_type: connection_type.into(),
        state: "connecting".into(),
        started_at: now_iso(),
        connected_at: None,
        ended_at: None,
        reason: None,
        recording,
        truncated: false,
    };
    save(db, keys, device_id, &item)
}

fn load(db: &LocalDb, keys: &KeySession, attempt_id: &str) -> Result<HistoryItem, String> {
    let row = db::get_sync_row(db, Table::SessionHistory, attempt_id)?
        .ok_or("session attempt not found")?;
    if row.deleted_at.is_some() {
        return Err("session attempt deleted".into());
    }
    decode(&row, keys)
}

pub fn mark_connected(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let mut item = load(db, keys, attempt_id)?;
    if item.state != "connecting" {
        return Err("session attempt is not connecting".into());
    }
    item.state = "connected".into();
    item.connected_at = Some(now_iso());
    save(db, keys, device_id, &item)
}

pub fn finish_attempt(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    attempt_id: &str,
    outcome: &str,
    reason: &str,
) -> Result<(), String> {
    if !matches!(outcome, "ended" | "failed" | "interrupted") {
        return Err("invalid session outcome".into());
    }
    let mut item = load(db, keys, attempt_id)?;
    if !matches!(item.state.as_str(), "connecting" | "connected") {
        return Ok(());
    }
    item.state = outcome.into();
    item.ended_at = Some(now_iso());
    item.reason = Some(reason.into());
    save(db, keys, device_id, &item)
}

pub fn list_attempts(db: &LocalDb, keys: &KeySession, vault_id: &str) -> Result<Vec<HistoryItem>, String> {
    let rows = db::list_sync_rows(db, Table::SessionHistory, vault_id, false)?;
    let mut items = rows.iter().map(|row| decode(row, keys)).collect::<Result<Vec<_>, _>>()?;
    items.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.id.cmp(&a.id)));
    Ok(items)
}

/// A chunk can arrive on a later sync page than its deleted parent. Queue a
/// matching tombstone once both rows are present; never expose the orphan.
pub fn reconcile_deleted_chunks(db: &LocalDb, keys: &KeySession, device_id: &str, vault_id: &str) -> Result<usize, String> {
    let deleted = db::list_sync_rows(db, Table::SessionHistory, vault_id, true)?
        .into_iter()
        .filter(|row| row.deleted_at.is_some())
        .map(|row| row.id)
        .collect::<std::collections::HashSet<_>>();
    if deleted.is_empty() { return Ok(0); }
    let mut targets = Vec::new();
    for row in db::list_sync_rows(db, Table::SessionOutputChunks, vault_id, false)? {
        let plaintext = crypto::decrypt_secret(&row.data, keys)?;
        let chunk: OutputChunk = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;
        if deleted.contains(&chunk.attempt_id) {
            targets.push((Table::SessionOutputChunks, row.id));
        }
    }
    let count = targets.len();
    db::tombstone_sync_rows_with_device(db, &targets, device_id)?;
    Ok(count)
}

pub fn recover_interrupted(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
    active_attempt_ids: &[String],
) -> Result<usize, String> {
    let unfinished = list_attempts(db, keys, vault_id)?
        .into_iter()
        .filter(|item| item.origin_device_id == device_id && matches!(item.state.as_str(), "connecting" | "connected") && !active_attempt_ids.contains(&item.id))
        .collect::<Vec<_>>();
    for item in &unfinished {
        finish_attempt(db, keys, device_id, &item.id, "interrupted", "app restarted")?;
    }
    Ok(unfinished.len())
}

#[derive(Debug, Serialize, Deserialize)]
struct OutputChunk {
    attempt_id: String,
    sequence: i64,
    captured_at: String,
    text: String,
}

fn save_chunk(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
    attempt_id: &str,
    buffer: &mut OutputBuffer,
    text: String,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let chunk = OutputChunk {
        attempt_id: attempt_id.into(),
        sequence: buffer.next_seq,
        captured_at: now_iso(),
        text,
    };
    let plaintext = serde_json::to_string(&chunk).map_err(|e| e.to_string())?;
    let data = crypto::encrypt_secret(&plaintext, Table::SessionOutputChunks.as_str(), keys)?;
    let row = SyncRow {
        id: uuid::Uuid::new_v4().to_string(),
        vault_id: vault_id.into(),
        name: Some("Output chunk".into()),
        sort_order: buffer.next_seq,
        data,
        ..SyncRow::default()
    };
    db::local_mutate(db, Table::SessionOutputChunks, &row, device_id)?;
    buffer.next_seq += 1;
    Ok(())
}

pub fn append_output(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    attempt_id: &str,
    buffer: &mut OutputBuffer,
    output: &str,
) -> Result<(), String> {
    let mut item = load(db, keys, attempt_id)?;
    if !item.recording || !matches!(item.state.as_str(), "connecting" | "connected") {
        return Ok(());
    }
    for chunk in buffer.push(output) {
        save_chunk(db, keys, device_id, &item.vault_id, attempt_id, buffer, chunk)?;
    }
    if buffer.truncated && !item.truncated {
        item.truncated = true;
        save(db, keys, device_id, &item)?;
    }
    Ok(())
}

pub fn flush_output(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    attempt_id: &str,
    buffer: &mut OutputBuffer,
) -> Result<bool, String> {
    let item = load(db, keys, attempt_id)?;
    let pending = buffer.finish();
    if pending.is_empty() { return Ok(false); }
    if let Err(error) = save_chunk(db, keys, device_id, &item.vault_id, attempt_id, buffer, pending.clone()) {
        buffer.pending = pending;
        return Err(error);
    }
    Ok(true)
}

pub fn read_output(db: &LocalDb, keys: &KeySession, vault_id: &str, attempt_id: &str) -> Result<String, String> {
    let item = load(db, keys, attempt_id)?;
    if item.vault_id != vault_id {
        return Err("session vault mismatch".into());
    }
    let rows = db::list_sync_rows(db, Table::SessionOutputChunks, vault_id, false)?;
    let mut chunks = Vec::new();
    for row in rows {
        let plaintext = crypto::decrypt_secret(&row.data, keys)?;
        let chunk: OutputChunk = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;
        if chunk.attempt_id == attempt_id {
            chunks.push(chunk);
        }
    }
    chunks.sort_by_key(|chunk| chunk.sequence);
    Ok(chunks.into_iter().map(|chunk| chunk.text).collect())
}

pub fn delete_attempt(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let item = load(db, keys, attempt_id)?;
    if item.vault_id != vault_id {
        return Err("session vault mismatch".into());
    }
    let mut targets = Vec::new();
    for row in db::list_sync_rows(db, Table::SessionOutputChunks, vault_id, false)? {
        let plaintext = crypto::decrypt_secret(&row.data, keys)?;
        let chunk: OutputChunk = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;
        if chunk.attempt_id == attempt_id {
            targets.push((Table::SessionOutputChunks, row.id));
        }
    }
    targets.push((Table::SessionHistory, attempt_id.into()));
    db::tombstone_sync_rows_with_device(db, &targets, device_id)
}

fn preference_id(vault_id: &str) -> Result<String, String> {
    preference_id_with_domain(vault_id, b"terra:session-preferences:")
}

fn legacy_preference_id(vault_id: &str) -> Result<String, String> {
    preference_id_with_domain(vault_id, b"termvault:session-preferences:")
}

fn preference_id_with_domain(vault_id: &str, domain: &[u8]) -> Result<String, String> {
    uuid::Uuid::parse_str(vault_id).map_err(|_| "invalid vault ID")?;
    let mut input = Vec::with_capacity(domain.len() + vault_id.len());
    input.extend_from_slice(domain);
    input.extend_from_slice(vault_id.as_bytes());
    let digest = Sha256::digest(input);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    retention_days: u32,
}

pub fn get_retention_days(db: &LocalDb, keys: &KeySession, vault_id: &str) -> Result<u32, String> {
    let id = preference_id(vault_id)?;
    let row = db::get_sync_row(db, Table::SessionPreferences, &id)?.or(db::get_sync_row(
        db,
        Table::SessionPreferences,
        &legacy_preference_id(vault_id)?,
    )?);
    let Some(row) = row else {
        return Ok(30);
    };
    if row.deleted_at.is_some() {
        return Ok(30);
    }
    if row.vault_id != vault_id {
        return Err("session preferences vault mismatch".into());
    }
    let plaintext = crypto::decrypt_secret(&row.data, keys)?;
    let preferences: Preferences = serde_json::from_str(&plaintext).map_err(|e| e.to_string())?;
    if !matches!(preferences.retention_days, 7 | 30 | 90) {
        return Err("invalid session retention value".into());
    }
    Ok(preferences.retention_days)
}

pub fn set_retention_days(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
    days: u32,
) -> Result<(), String> {
    if !matches!(days, 7 | 30 | 90) {
        return Err("retention must be 7, 30, or 90 days".into());
    }
    let plaintext = serde_json::to_string(&Preferences { retention_days: days }).map_err(|e| e.to_string())?;
    let data = crypto::encrypt_secret(&plaintext, Table::SessionPreferences.as_str(), keys)?;
    let row = SyncRow {
        id: preference_id(vault_id)?,
        vault_id: vault_id.into(),
        name: Some("Session preferences".into()),
        data,
        ..SyncRow::default()
    };
    db::local_mutate(db, Table::SessionPreferences, &row, device_id)?;
    Ok(())
}

pub fn apply_retention(
    db: &LocalDb,
    keys: &KeySession,
    device_id: &str,
    vault_id: &str,
) -> Result<usize, String> {
    let days = get_retention_days(db, keys, vault_id)?;
    let threshold = Utc::now() - Duration::days(i64::from(days));
    let expired = list_attempts(db, keys, vault_id)?
        .into_iter()
        .filter(|item| !matches!(item.state.as_str(), "connecting" | "connected"))
        .filter(|item| {
            item.ended_at.as_deref().or(Some(item.started_at.as_str()))
                .and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok())
                .is_some_and(|stamp| stamp.with_timezone(&Utc) < threshold)
        })
        .collect::<Vec<_>>();
    for item in &expired {
        delete_attempt(db, keys, device_id, vault_id, &item.id)?;
    }
    Ok(expired.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terra_preference_ids_are_new_but_legacy_preferences_still_load() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();

        let legacy_id = legacy_preference_id_for_test(&vault_id);
        assert_ne!(preference_id(&vault_id).unwrap(), legacy_id);
        let encrypted = crypto::encrypt_secret(
            r#"{"retention_days":7}"#,
            Table::SessionPreferences.as_str(),
            &keys,
        )
        .unwrap();
        db::local_mutate(
            &db,
            Table::SessionPreferences,
            &SyncRow {
                id: legacy_id,
                vault_id: vault_id.clone(),
                name: Some("Session preferences".into()),
                data: encrypted,
                ..SyncRow::default()
            },
            &device_id,
        )
        .unwrap();

        assert_eq!(get_retention_days(&db, &keys, &vault_id).unwrap(), 7);
    }

    fn legacy_preference_id_for_test(vault_id: &str) -> String {
        let digest = Sha256::digest(format!("termvault:session-preferences:{vault_id}").as_bytes());
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        uuid::Uuid::from_bytes(bytes).to_string()
    }

    #[test]
    fn session_attempt_finishes_without_reopening() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        }
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();
        let attempt_id = uuid::Uuid::new_v4().to_string();
        start_attempt(&db, &keys, &device_id, &vault_id, &attempt_id, "host-1", "Prod", "ssh", false).unwrap();
        mark_connected(&db, &keys, &device_id, &attempt_id).unwrap();
        finish_attempt(&db, &keys, &device_id, &attempt_id, "ended", "pane closed").unwrap();
        assert!(mark_connected(&db, &keys, &device_id, &attempt_id).is_err());
        let items = list_attempts(&db, &keys, &vault_id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state, "ended");
        assert_eq!(items[0].host_label, "Prod");
        assert_eq!(items[0].reason.as_deref(), Some("pane closed"));
    }

    #[test]
    fn recovery_marks_only_this_devices_unfinished_attempts() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();
        let this_device = uuid::Uuid::new_v4().to_string();
        let other_device = uuid::Uuid::new_v4().to_string();
        let own = uuid::Uuid::new_v4().to_string();
        let remote = uuid::Uuid::new_v4().to_string();
        start_attempt(&db, &keys, &this_device, &vault_id, &own, "h", "Own", "ssh", false).unwrap();
        start_attempt(&db, &keys, &other_device, &vault_id, &remote, "h", "Remote", "ssh", false).unwrap();
        assert_eq!(recover_interrupted(&db, &keys, &this_device, &vault_id, &[]).unwrap(), 1);
        assert_eq!(load(&db, &keys, &own).unwrap().state, "interrupted");
        assert_eq!(load(&db, &keys, &remote).unwrap().state, "connecting");
        assert_eq!(recover_interrupted(&db, &keys, &this_device, &vault_id, &[]).unwrap(), 0);
    }

    #[test]
    fn retention_setting_is_encrypted_and_expired_attempts_are_deleted() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();
        assert_eq!(get_retention_days(&db, &keys, &vault_id).unwrap(), 30);
        set_retention_days(&db, &keys, &device_id, &vault_id, 7).unwrap();
        assert_eq!(get_retention_days(&db, &keys, &vault_id).unwrap(), 7);
        let rows = db::list_sync_rows(&db, Table::SessionPreferences, &vault_id, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].data.contains("retention_days"));
        assert!(set_retention_days(&db, &keys, &device_id, &vault_id, 8).is_err());
        let attempt_id = uuid::Uuid::new_v4().to_string();
        start_attempt(&db, &keys, &device_id, &vault_id, &attempt_id, "h", "Old", "ssh", false).unwrap();
        let mut old = load(&db, &keys, &attempt_id).unwrap();
        old.state = "ended".into();
        old.ended_at = Some("2020-01-01T00:00:00.000Z".into());
        save(&db, &keys, &device_id, &old).unwrap();
        assert_eq!(apply_retention(&db, &keys, &device_id, &vault_id).unwrap(), 1);
        assert!(list_attempts(&db, &keys, &vault_id).unwrap().is_empty());
    }

    #[test]
    fn output_buffer_preserves_utf8_and_caps_recording() {
        let mut buffer = OutputBuffer::default();
        let text = "🙂".repeat(20_000);
        let chunks = buffer.push(&text);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].len() <= 64 * 1024);
        assert_eq!(chunks[0].clone() + &buffer.finish(), text);

        let mut capped = OutputBuffer::default();
        let chunks = capped.push(&"x".repeat(10 * 1024 * 1024 + 100));
        assert_eq!(chunks.iter().map(String::len).sum::<usize>() + capped.finish().len(), 10 * 1024 * 1024);
        assert!(capped.truncated);
    }

    #[test]
    fn opted_in_output_is_encrypted_and_ordered() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();
        let attempt_id = uuid::Uuid::new_v4().to_string();
        start_attempt(&db, &keys, &device_id, &vault_id, &attempt_id, "h", "Host", "ssh", true).unwrap();
        let mut buffer = OutputBuffer::default();
        append_output(&db, &keys, &device_id, &attempt_id, &mut buffer, &"secret-output".repeat(7000)).unwrap();
        flush_output(&db, &keys, &device_id, &attempt_id, &mut buffer).unwrap();
        let rows = db::list_sync_rows(&db, Table::SessionOutputChunks, &vault_id, false).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| !row.data.contains("secret-output")));
        let output = read_output(&db, &keys, &vault_id, &attempt_id).unwrap();
        assert_eq!(output, "secret-output".repeat(7000));
        delete_attempt(&db, &keys, &device_id, &vault_id, &attempt_id).unwrap();
        assert!(list_attempts(&db, &keys, &vault_id).unwrap().is_empty());
        assert!(read_output(&db, &keys, &vault_id, &attempt_id).is_err());
        assert!(db::list_sync_rows(&db, Table::SessionOutputChunks, &vault_id, false).unwrap().is_empty());
    }

    #[test]
    fn late_chunk_for_deleted_attempt_is_tombstoned() {
        let db = crate::db::open(":memory:").unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute("INSERT INTO vaults (id, owner_id, kind, name, is_default, created_at, updated_at) VALUES (?1, ?2, 'personal', 'Personal', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", rusqlite::params![vault_id, owner_id]).unwrap();
        let mut keys = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut keys).unwrap();
        let attempt_id = uuid::Uuid::new_v4().to_string();
        start_attempt(&db, &keys, &device_id, &vault_id, &attempt_id, "h", "Host", "ssh", true).unwrap();
        delete_attempt(&db, &keys, &device_id, &vault_id, &attempt_id).unwrap();
        let mut buffer = OutputBuffer::default();
        save_chunk(&db, &keys, &device_id, &vault_id, &attempt_id, &mut buffer, "late".into()).unwrap();
        assert_eq!(reconcile_deleted_chunks(&db, &keys, &device_id, &vault_id).unwrap(), 1);
        assert!(db::list_sync_rows(&db, Table::SessionOutputChunks, &vault_id, false).unwrap().is_empty());
        assert_eq!(reconcile_deleted_chunks(&db, &keys, &device_id, &vault_id).unwrap(), 0);
    }
}
