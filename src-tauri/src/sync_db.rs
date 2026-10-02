//! Transactional local side of the encrypted sync protocol.
//! The caller must supply encrypted record envelopes; no plaintext is written here.
use super::{get_sync_row_unlocked, row_vals, table_cols, LocalDb, SyncRow, Table, ENVELOPE_COLS};
use base64::{
    engine::general_purpose::{STANDARD as BASE64_PADDED, STANDARD_NO_PAD as BASE64},
    Engine as _,
};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingOperation {
    pub operation_id: String,
    pub table: String,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullChange {
    pub cursor: u64,
    pub table: String,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResult {
    pub operation_id: String,
    pub fate: String,
    pub canonical_record: Value,
    pub cursor: u64,
}

fn row_vault_id(table: Table, row: &SyncRow) -> &str {
    if table == Table::Vaults {
        &row.id
    } else {
        &row.vault_id
    }
}

fn edit_tuple(row: &SyncRow) -> (&str, &str, &str) {
    (&row.edited_at, &row.device_id, &row.operation_id)
}

fn expected_fields(table: Table) -> &'static [&'static str] {
    match table {
        Table::Vaults => &["owner_id", "kind", "is_default"],
        Table::Groups => &["parent_id"],
        Table::Hosts => &["os", "auth_type", "tags", "color", "group_id", "key_id"],
        Table::Keys => &["description", "key_type", "fingerprint", "public_key"],
        Table::Snippets => &["description", "tags"],
        Table::Workspaces | Table::Presets => &[],
        Table::PortForwards => &["host_id", "mode"],
    }
}

fn record_value(table: Table, row: &SyncRow) -> Result<Value, String> {
    let value = serde_json::to_value(row).map_err(|e| e.to_string())?;
    let mut map = value
        .as_object()
        .cloned()
        .ok_or("sync row is not an object")?;
    const COMMON: &[&str] = &[
        "id",
        "vault_id",
        "revision",
        "created_at",
        "updated_at",
        "deleted_at",
        "edited_at",
        "device_id",
        "operation_id",
        "name",
        "sort_order",
        "data",
    ];
    map.retain(|key, _| {
        COMMON.contains(&key.as_str()) || expected_fields(table).contains(&key.as_str())
    });
    if table == Table::Vaults {
        map.insert("vault_id".into(), Value::String(String::new()));
        map.insert("is_default".into(), Value::Bool(row.is_default != 0));
    }
    Ok(Value::Object(map))
}

fn validate_ciphertext(table: Table, data: &str) -> Result<(), String> {
    if table == Table::Vaults && data == "{}" {
        return Ok(());
    }
    let value: Value = serde_json::from_str(data).map_err(|_| "invalid encrypted data")?;
    let field = |name: &str| value.get(name).and_then(Value::as_str).unwrap_or("");
    let version = value.get("v").and_then(Value::as_i64);
    if field("alg") != "xchacha20poly1305" {
        return Err("unsupported encrypted data envelope".into());
    }
    match version {
        Some(1)
            if field("aad") == BASE64.encode(table.as_str())
                || field("aad") == BASE64_PADDED.encode(table.as_str()) => {}
        Some(2)
            if field("record_type") == table.as_str()
                && value
                    .get("epoch")
                    .and_then(Value::as_u64)
                    .is_some_and(|epoch| epoch > 0)
                && uuid::Uuid::parse_str(field("vault_id")).is_ok() => {}
        _ => return Err("unsupported encrypted data envelope".into()),
    }
    let decode = |value| {
        BASE64
            .decode(value)
            .or_else(|_| BASE64_PADDED.decode(value))
    };
    let nonce = decode(field("nonce")).map_err(|_| "invalid encrypted nonce")?;
    let ct = decode(field("ct")).map_err(|_| "invalid encrypted body")?;
    if nonce.len() != 24 || ct.len() < 16 {
        return Err("invalid encrypted data lengths".into());
    }
    Ok(())
}

fn parse_record(table: Table, vault_id: &str, value: &Value) -> Result<SyncRow, String> {
    let mut value = value.clone();
    let map = value
        .as_object_mut()
        .ok_or("sync record is not an object")?;
    if table == Table::Vaults {
        if let Some(flag) = map.get("is_default").and_then(Value::as_bool) {
            map.insert("is_default".into(), Value::from(i64::from(flag)));
        }
    }
    const COMMON: &[&str] = &[
        "id",
        "vault_id",
        "revision",
        "created_at",
        "updated_at",
        "deleted_at",
        "edited_at",
        "device_id",
        "operation_id",
        "name",
        "sort_order",
        "data",
    ];
    for field in map.keys() {
        if !COMMON.contains(&field.as_str()) && !expected_fields(table).contains(&field.as_str()) {
            return Err(format!("unexpected plaintext sync field {field}"));
        }
    }
    let row: SyncRow =
        serde_json::from_value(value).map_err(|e| format!("invalid sync record: {e}"))?;
    if row_vault_id(table, &row) != vault_id {
        return Err("sync record vault mismatch".into());
    }
    for id in [&row.id, &row.device_id, &row.operation_id] {
        uuid::Uuid::parse_str(id).map_err(|_| "invalid sync record UUID")?;
    }
    if table == Table::Vaults {
        if !row.vault_id.is_empty() {
            return Err("vault record has a vault_id".into());
        }
    } else {
        uuid::Uuid::parse_str(&row.vault_id).map_err(|_| "invalid sync vault UUID")?;
    }
    for stamp in [&row.created_at, &row.updated_at, &row.edited_at] {
        if super::canonical_utc_millis(stamp)? != *stamp {
            return Err("noncanonical sync timestamp".into());
        }
    }
    if let Some(stamp) = &row.deleted_at {
        if super::canonical_utc_millis(stamp)? != *stamp {
            return Err("noncanonical deletion timestamp".into());
        }
    }
    validate_ciphertext(table, &row.data)?;
    if let Ok(header) = serde_json::from_str::<Value>(&row.data) {
        if header.get("v").and_then(Value::as_i64) == Some(2)
            && header.get("vault_id").and_then(Value::as_str) != Some(vault_id)
        {
            return Err("team ciphertext vault mismatch".into());
        }
    }
    Ok(row)
}

pub(crate) fn write_row(conn: &Connection, table: Table, row: &SyncRow) -> Result<(), String> {
    let cols = table_cols(table);
    let all = format!("{ENVELOPE_COLS}, {cols}");
    let count = all.split(',').count();
    let placeholders = (1..=count)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let updates = all
        .split(',')
        .map(str::trim)
        .filter(|c| *c != "id")
        .map(|c| format!("{c} = excluded.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({all}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}",
        table.as_str()
    );
    let values = row_vals(row, cols);
    conn.execute(&sql, params_from_iter(values))
        .map_err(|e| format!("write sync row: {e}"))?;
    Ok(())
}

pub(crate) fn queue_row(
    conn: &Connection,
    table: Table,
    row: &SyncRow,
    queued_at: &str,
) -> Result<(), String> {
    let vault_id = row_vault_id(table, row);
    conn.execute("INSERT INTO outbox (table_name, record_id, queued_at, vault_id, operation_id, device_id, edited_at, generation) \
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1) \
                  ON CONFLICT(table_name, record_id) DO UPDATE SET queued_at = excluded.queued_at, vault_id = excluded.vault_id, \
                  operation_id = excluded.operation_id, device_id = excluded.device_id, edited_at = excluded.edited_at, generation = outbox.generation + 1",
        params![table.as_str(), row.id, queued_at, vault_id, row.operation_id, row.device_id, row.edited_at])
        .map_err(|e| format!("queue sync operation: {e}"))?;
    Ok(())
}

/// Bind pre-sync legacy edits to the enrolled device before uploading them.
pub fn adopt_pending_device(db: &LocalDb, device_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx.prepare("SELECT table_name, record_id, operation_id FROM outbox WHERE device_id = '' OR device_id = ?1")
        .map_err(|e| e.to_string())?;
    let nil = uuid::Uuid::nil().to_string();
    let entries = stmt
        .query_map([&nil], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (table_name, id, operation_id) in entries {
        let table = Table::parse(&table_name)?;
        tx.execute(
            &format!(
                "UPDATE {} SET device_id = ?1 WHERE id = ?2 AND operation_id = ?3",
                table.as_str()
            ),
            params![device_id, id, operation_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE outbox SET device_id = ?1 WHERE table_name = ?2 AND record_id = ?3 AND operation_id = ?4",
            params![device_id, table_name, id, operation_id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Authenticate downloaded ciphertext with the unlocked account DEK before any
/// row or pull cursor is committed. Envelope-shape validation alone is not enough.
pub fn validate_pull_payloads(
    db: &LocalDb,
    changes: &[PullChange],
    session: &crate::crypto::KeySession,
) -> Result<(), String> {
    for change in changes {
        let table = Table::parse(&change.table)?;
        let data = change
            .record
            .get("data")
            .and_then(Value::as_str)
            .ok_or("sync data missing")?;
        validate_ciphertext(table, data)?;
        if table == Table::Vaults && data == "{}" {
            continue;
        }
        let vault_id = if table == Table::Vaults {
            change
                .record
                .get("id")
                .and_then(Value::as_str)
                .ok_or("sync vault ID missing")?
        } else {
            change
                .record
                .get("vault_id")
                .and_then(Value::as_str)
                .ok_or("sync vault ID missing")?
        };
        crate::team_keys::decrypt_row_secret(db, session, data, table.as_str(), vault_id)
            .map_err(|_| "unreadable encrypted sync record".to_string())?;
    }
    Ok(())
}

pub fn pending_batch(
    db: &LocalDb,
    vault_id: &str,
    limit: usize,
) -> Result<Vec<PendingOperation>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT o.table_name, o.record_id, o.operation_id FROM outbox o
        WHERE o.vault_id = ?1
          AND NOT EXISTS (SELECT 1 FROM sync_cancelled_vaults c WHERE c.vault_id = o.vault_id)
          AND (
            o.table_name <> 'vaults'
            OR EXISTS (SELECT 1 FROM vaults v WHERE v.id = o.record_id AND v.deleted_at IS NULL)
            OR NOT EXISTS (SELECT 1 FROM outbox child WHERE child.vault_id = o.vault_id AND child.table_name <> 'vaults')
        )
        ORDER BY CASE WHEN o.table_name = 'vaults' AND EXISTS (SELECT 1 FROM vaults v WHERE v.id = o.record_id AND v.deleted_at IS NULL) THEN -1
                      WHEN o.table_name = 'vaults' THEN 1 ELSE 0 END,
                 o.queued_at, o.table_name, o.record_id LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params![vault_id, limit.min(100) as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut result = Vec::with_capacity(entries.len());
    for (table_name, id, operation_id) in entries {
        let table = Table::parse(&table_name)?;
        let row = get_sync_row_unlocked(&conn, table, &id)?.ok_or("outbox record missing")?;
        if row_vault_id(table, &row) != vault_id || row.operation_id != operation_id {
            return Err("outbox and current row differ".into());
        }
        validate_ciphertext(table, &row.data)?;
        result.push(PendingOperation {
            operation_id,
            table: table_name,
            record: record_value(table, &row)?,
        });
    }
    Ok(result)
}

pub fn pending_team_rows(db: &LocalDb, vault_id: &str) -> Result<Vec<(Table, SyncRow)>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT table_name, record_id, operation_id FROM outbox WHERE vault_id = ?1 AND table_name <> 'vaults' ORDER BY table_name, record_id",
    ).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map([vault_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut result = Vec::with_capacity(entries.len());
    for (table_name, id, operation_id) in entries {
        let table = Table::parse(&table_name)?;
        let row = get_sync_row_unlocked(&conn, table, &id)?.ok_or("outbox record missing")?;
        if row.vault_id != vault_id || row.operation_id != operation_id {
            return Err("outbox and current row differ".into());
        }
        result.push((table, row));
    }
    Ok(result)
}

pub struct RebasedPendingRow {
    pub table: Table,
    pub previous_operation_id: String,
    pub row: SyncRow,
}

pub fn replace_pending_team_rows(
    db: &LocalDb,
    vault_id: &str,
    rows: &[RebasedPendingRow],
) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for item in rows {
        if item.table == Table::Vaults || item.row.vault_id != vault_id {
            return Err("invalid pending team row".into());
        }
        let current = get_sync_row_unlocked(&tx, item.table, &item.row.id)?
            .ok_or("pending row disappeared")?;
        let queued: Option<String> = tx.query_row(
            "SELECT operation_id FROM outbox WHERE table_name = ?1 AND record_id = ?2 AND vault_id = ?3",
            params![item.table.as_str(), item.row.id, vault_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if current.operation_id != item.previous_operation_id
            || queued.as_deref() != Some(item.previous_operation_id.as_str())
        {
            return Err("pending team row changed during rebase".into());
        }
        validate_ciphertext(item.table, &item.row.data)?;
        write_row(&tx, item.table, &item.row)?;
        queue_row(&tx, item.table, &item.row, &item.row.edited_at)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn discard_revoked_pending_edits(db: &LocalDb, vault_id: &str) -> Result<usize, String> {
    let (_, _, state) = super::team_vault_meta(db, vault_id)?.ok_or("not a team vault")?;
    if state != "revoked" {
        return Err("team vault access is not revoked".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM outbox WHERE vault_id = ?1 AND table_name <> 'vaults'",
        [vault_id],
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct RevokedVaultEdits {
    pub vault_id: String,
    pub name: String,
    pub pending: usize,
}

pub fn list_revoked_pending_edits(db: &LocalDb) -> Result<Vec<RevokedVaultEdits>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.vault_id, COALESCE(v.name, 'Shared vault'), COUNT(o.record_id)
        FROM team_vaults t
        LEFT JOIN vaults v ON v.id = t.vault_id
        JOIN outbox o ON o.vault_id = t.vault_id AND o.table_name <> 'vaults'
        WHERE t.rotation_state = 'revoked'
        GROUP BY t.vault_id, v.name ORDER BY v.name, t.vault_id",
        )
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([], |row| {
            Ok(RevokedVaultEdits {
                vault_id: row.get(0)?,
                name: row.get(1)?,
                pending: row.get::<_, i64>(2)? as usize,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

pub fn pending_count(db: &LocalDb, vault_id: &str) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM outbox o WHERE o.vault_id = ?1 AND NOT EXISTS (SELECT 1 FROM sync_cancelled_vaults c WHERE c.vault_id = o.vault_id)",
        [vault_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n as usize)
    .map_err(|e| e.to_string())
}

pub fn is_known_vault(db: &LocalDb, vault_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_known_vaults WHERE vault_id = ?1)",
        [vault_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn is_cancelled_vault(db: &LocalDb, vault_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_cancelled_vaults WHERE vault_id = ?1)",
        [vault_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn last_sync_at(db: &LocalDb, vault_id: &str) -> Result<Option<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT last_sync_at FROM __sync_meta WHERE vault_id = ?1",
        [vault_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .or_else(|err| {
        if err == rusqlite::Error::QueryReturnedNoRows {
            Ok(None)
        } else {
            Err(err)
        }
    })
    .map_err(|e| e.to_string())
}

pub fn mark_sync_complete(db: &LocalDb, vault_id: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO __sync_meta (vault_id, last_sync_at) VALUES (?1, ?2) ON CONFLICT(vault_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
        params![vault_id, super::now_iso()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn pull_cursor(db: &LocalDb, vault_id: &str) -> Result<u64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT cursor FROM __sync_meta WHERE vault_id = ?1",
        [vault_id],
        |r| r.get::<_, u64>(0),
    )
    .or_else(|err| {
        if err == rusqlite::Error::QueryReturnedNoRows {
            Ok(0)
        } else {
            Err(err)
        }
    })
    .map_err(|e| e.to_string())
}

pub fn apply_pull_page(
    db: &LocalDb,
    vault_id: &str,
    changes: &[PullChange],
    next_cursor: u64,
) -> Result<(), String> {
    apply_pull_page_with_rotation(db, vault_id, changes, next_cursor, false, false, 0)
}

pub fn apply_pull_page_with_rotation(
    db: &LocalDb,
    vault_id: &str,
    changes: &[PullChange],
    next_cursor: u64,
    reset: bool,
    has_more: bool,
    rotation_cursor: u64,
) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current_cursor = tx
        .query_row(
            "SELECT cursor FROM __sync_meta WHERE vault_id = ?1",
            [vault_id],
            |r| r.get::<_, u64>(0),
        )
        .or_else(|err| {
            if err == rusqlite::Error::QueryReturnedNoRows {
                Ok(0)
            } else {
                Err(err)
            }
        })
        .map_err(|e| e.to_string())?;
    if next_cursor < current_cursor {
        return Err("sync cursor cannot move backward".into());
    }
    if reset {
        if rotation_cursor == 0
            || next_cursor < rotation_cursor
            || changes
                .first()
                .is_none_or(|change| change.cursor != rotation_cursor || change.table != "vaults")
        {
            return Err("invalid rotation snapshot boundary".into());
        }
        tx.execute(
            "DELETE FROM sync_snapshot_seen WHERE vault_id = ?1",
            [vault_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO sync_snapshot_state (vault_id, boundary) VALUES (?1, ?2)
            ON CONFLICT(vault_id) DO UPDATE SET boundary = excluded.boundary",
            params![vault_id, rotation_cursor],
        )
        .map_err(|e| e.to_string())?;
    }
    let active_boundary: Option<u64> = tx
        .query_row(
            "SELECT boundary FROM sync_snapshot_state WHERE vault_id = ?1",
            [vault_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if active_boundary.is_some_and(|boundary| boundary != rotation_cursor) {
        return Err("rotation snapshot boundary changed".into());
    }
    let mut last = current_cursor;
    for change in changes {
        if change.cursor <= last || change.cursor > next_cursor {
            return Err("sync change cursor out of order".into());
        }
        let table = Table::parse(&change.table)?;
        let remote = parse_record(table, vault_id, &change.record)?;
        if table == Table::Vaults {
            tx.execute(
                "INSERT OR IGNORE INTO sync_known_vaults (vault_id) VALUES (?1)",
                [vault_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM sync_cancelled_vaults WHERE vault_id = ?1",
                [vault_id],
            )
            .map_err(|e| e.to_string())?;
        }
        if active_boundary.is_some() && table != Table::Vaults {
            tx.execute("INSERT OR IGNORE INTO sync_snapshot_seen (vault_id, table_name, record_id) VALUES (?1, ?2, ?3)",
                params![vault_id, table.as_str(), remote.id]).map_err(|e| e.to_string())?;
        }
        let local = get_sync_row_unlocked(&tx, table, &remote.id)?;
        if local
            .as_ref()
            .is_some_and(|row| row_vault_id(table, row) != vault_id)
        {
            return Err("cross-vault sync record collision".into());
        }
        let pending_local = if active_boundary.is_some() {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE table_name = ?1 AND record_id = ?2)",
                params![table.as_str(), remote.id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        } else {
            false
        };
        if !pending_local
            && (active_boundary.is_some()
                || local
                    .as_ref()
                    .is_none_or(|row| edit_tuple(&remote) > edit_tuple(row)))
        {
            write_row(&tx, table, &remote)?;
            if let Some(row) = local {
                tx.execute("DELETE FROM outbox WHERE table_name = ?1 AND record_id = ?2 AND operation_id = ?3", params![table.as_str(), row.id, row.operation_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        last = change.cursor;
    }
    if active_boundary.is_some() && !has_more {
        for table in [
            Table::Groups,
            Table::Hosts,
            Table::Keys,
            Table::Snippets,
            Table::Workspaces,
            Table::Presets,
            Table::PortForwards,
        ] {
            let sql = format!("DELETE FROM {} WHERE vault_id = ?1
                AND id NOT IN (SELECT record_id FROM sync_snapshot_seen WHERE vault_id = ?1 AND table_name = ?2)
                AND id NOT IN (SELECT record_id FROM outbox WHERE vault_id = ?1 AND table_name = ?2)", table.as_str());
            tx.execute(&sql, params![vault_id, table.as_str()])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "DELETE FROM sync_snapshot_state WHERE vault_id = ?1",
            [vault_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM sync_snapshot_seen WHERE vault_id = ?1",
            [vault_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("INSERT INTO __sync_meta (vault_id, cursor) VALUES (?1, ?2) ON CONFLICT(vault_id) DO UPDATE SET cursor = excluded.cursor", params![vault_id, next_cursor])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn ack_push_results(
    db: &LocalDb,
    vault_id: &str,
    results: &[PushResult],
) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for result in results {
        if result.canonical_record.get("id").and_then(Value::as_str) == Some(vault_id)
            && result
                .canonical_record
                .get("vault_id")
                .and_then(Value::as_str)
                == Some("")
        {
            tx.execute(
                "INSERT OR IGNORE INTO sync_known_vaults (vault_id) VALUES (?1)",
                [vault_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM sync_cancelled_vaults WHERE vault_id = ?1",
                [vault_id],
            )
            .map_err(|e| e.to_string())?;
        }
        let mut stmt = tx.prepare("SELECT table_name, record_id FROM outbox WHERE vault_id = ?1 AND operation_id = ?2")
            .map_err(|e| e.to_string())?;
        let matched = stmt
            .query_row(params![vault_id, result.operation_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        let Some((table_name, id)) = matched else {
            continue;
        }; // A newer local operation replaced it.
        let table = Table::parse(&table_name)?;
        let remote = parse_record(table, vault_id, &result.canonical_record)?;
        if remote.id != id {
            return Err("push acknowledgement record mismatch".into());
        }
        let current = get_sync_row_unlocked(&tx, table, &id)?.ok_or("acknowledged row missing")?;
        if row_vault_id(table, &current) != vault_id {
            return Err("cross-vault acknowledgement collision".into());
        }
        if edit_tuple(&remote) >= edit_tuple(&current) {
            write_row(&tx, table, &remote)?;
        }
        tx.execute(
            "DELETE FROM outbox WHERE table_name = ?1 AND record_id = ?2 AND operation_id = ?3",
            params![table_name, id, result.operation_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn ciphertext(table: Table) -> String {
        serde_json::json!({
            "v": 1,
            "alg": "xchacha20poly1305",
            "nonce": BASE64.encode([0u8; 24]),
            "ct": BASE64.encode([0u8; 32]),
            "aad": BASE64.encode(table.as_str()),
        })
        .to_string()
    }

    fn host(id: &str, vault: &str, name: &str) -> SyncRow {
        SyncRow {
            id: id.into(),
            vault_id: vault.into(),
            name: Some(name.into()),
            data: ciphertext(Table::Hosts),
            ..Default::default()
        }
    }

    #[test]
    fn sync_db_validates_team_ciphertext_with_cached_vault_key() {
        let db = super::super::open(":memory:").unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        super::super::store_team_vault_meta(
            &db,
            "11111111-1111-4111-8111-111111111111",
            "team",
            1,
            "ready",
        )
        .unwrap();
        let key = [5u8; 32];
        let encrypted = crate::crypto::encrypt_team_secret(
            "secret",
            "hosts",
            "11111111-1111-4111-8111-111111111111",
            1,
            &key,
            &session,
        )
        .unwrap();
        let change = PullChange {
            cursor: 1,
            table: "hosts".into(),
            record: serde_json::json!({"vault_id":"11111111-1111-4111-8111-111111111111","data":encrypted}),
        };
        assert!(validate_pull_payloads(&db, &[change.clone()], &session).is_err());
        let wrapped = crate::crypto::wrap_team_key(
            &key,
            "team",
            "11111111-1111-4111-8111-111111111111",
            1,
            &session,
        )
        .unwrap();
        super::super::store_wrapped_team_key(
            &db,
            "11111111-1111-4111-8111-111111111111",
            "team",
            1,
            &wrapped,
        )
        .unwrap();
        validate_pull_payloads(&db, &[change], &session).unwrap();
    }

    #[test]
    fn sync_db_rejects_well_shaped_unreadable_ciphertext() {
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let encrypted = crate::crypto::encrypt_secret("secret", "hosts", &session).unwrap();
        let db = super::super::open(":memory:").unwrap();
        let valid = PullChange {
            cursor: 1,
            table: "hosts".into(),
            record: serde_json::json!({"vault_id":"private","data":encrypted}),
        };
        validate_pull_payloads(&db, &[valid.clone()], &session).unwrap();
        let mut corrupt = valid;
        let mut payload: Value =
            serde_json::from_str(corrupt.record["data"].as_str().unwrap()).unwrap();
        let mut ct = BASE64.decode(payload["ct"].as_str().unwrap()).unwrap();
        ct[0] ^= 1;
        payload["ct"] = Value::String(BASE64.encode(ct));
        corrupt.record["data"] = Value::String(payload.to_string());
        assert!(validate_pull_payloads(&db, &[corrupt], &session).is_err());
    }

    #[test]
    fn sync_db_outbox_failure_rolls_back_local_row() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;").unwrap();
        assert!(super::super::local_mutate(
            &db,
            Table::Hosts,
            &host(&id, &vault, "new"),
            &Uuid::new_v4().to_string()
        )
        .is_err());
        assert!(super::super::get_sync_row(&db, Table::Hosts, &id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn sync_db_local_write_and_newer_edit_survive_old_ack() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        let first =
            super::super::upsert_sync_row(&db, Table::Hosts, &host(&id, &vault, "first")).unwrap();
        let sent = pending_batch(&db, &vault, 10).unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].operation_id, first.operation_id);
        let newer =
            super::super::upsert_sync_row(&db, Table::Hosts, &host(&id, &vault, "newer")).unwrap();
        assert_ne!(first.operation_id, newer.operation_id);
        ack_push_results(
            &db,
            &vault,
            &[PushResult {
                operation_id: first.operation_id.clone(),
                fate: "accepted".into(),
                canonical_record: record_value(Table::Hosts, &first).unwrap(),
                cursor: 1,
            }],
        )
        .unwrap();
        let pending = pending_batch(&db, &vault, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation_id, newer.operation_id);
        assert_eq!(
            super::super::get_sync_row(&db, Table::Hosts, &id)
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("newer")
        );
    }

    #[test]
    fn sync_db_pull_is_atomic_and_does_not_queue_remote_rows() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        let local =
            super::super::upsert_sync_row(&db, Table::Hosts, &host(&id, &vault, "local")).unwrap();
        let mut remote = local.clone();
        remote.name = Some("remote".into());
        remote.edited_at = "2099-01-01T00:00:00.000Z".into();
        remote.updated_at = remote.edited_at.clone();
        remote.device_id = Uuid::new_v4().to_string();
        remote.operation_id = Uuid::new_v4().to_string();
        let good = PullChange {
            cursor: 1,
            table: "hosts".into(),
            record: record_value(Table::Hosts, &remote).unwrap(),
        };
        let mut malformed = good.clone();
        malformed.cursor = 2;
        malformed.record["data"] = Value::String("plaintext".into());
        assert!(apply_pull_page(&db, &vault, &[good.clone(), malformed], 2).is_err());
        assert_eq!(pull_cursor(&db, &vault).unwrap(), 0);
        assert_eq!(
            super::super::get_sync_row(&db, Table::Hosts, &id)
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("local")
        );
        apply_pull_page(&db, &vault, &[good], 1).unwrap();
        assert_eq!(pull_cursor(&db, &vault).unwrap(), 1);
        assert_eq!(
            super::super::get_sync_row(&db, Table::Hosts, &id)
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("remote")
        );
        assert!(pending_batch(&db, &vault, 10).unwrap().is_empty());
    }

    #[test]
    fn rotation_snapshot_prunes_only_after_final_page_and_preserves_pending_edits() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let kept = Uuid::new_v4().to_string();
        let stale = Uuid::new_v4().to_string();
        let pending = Uuid::new_v4().to_string();
        let device = Uuid::new_v4().to_string();
        let local_vault = super::super::upsert_sync_row(
            &db,
            Table::Vaults,
            &SyncRow {
                id: vault.clone(),
                owner_id: Some(Uuid::new_v4().to_string()),
                kind: Some("team".into()),
                name: Some("Shared".into()),
                data: "{}".into(),
                ..Default::default()
            },
        )
        .unwrap();
        super::super::upsert_sync_row(&db, Table::Hosts, &host(&kept, &vault, "old")).unwrap();
        super::super::upsert_sync_row(&db, Table::Hosts, &host(&stale, &vault, "stale")).unwrap();
        super::super::outbox_remove(&db, Table::Vaults, &vault).unwrap();
        super::super::outbox_remove(&db, Table::Hosts, &kept).unwrap();
        super::super::outbox_remove(&db, Table::Hosts, &stale).unwrap();
        super::super::local_mutate(
            &db,
            Table::Hosts,
            &host(&pending, &vault, "pending"),
            &device,
        )
        .unwrap();
        let mut marker = local_vault.clone();
        marker.revision = 2;
        marker.edited_at = "2099-01-01T00:00:00.000Z".into();
        marker.updated_at = marker.edited_at.clone();
        marker.device_id = Uuid::new_v4().to_string();
        marker.operation_id = Uuid::new_v4().to_string();
        let marker = PullChange {
            cursor: 2,
            table: "vaults".into(),
            record: record_value(Table::Vaults, &marker).unwrap(),
        };
        apply_pull_page_with_rotation(&db, &vault, &[marker], 2, true, true, 2).unwrap();
        assert!(super::super::get_sync_row(&db, Table::Hosts, &stale)
            .unwrap()
            .is_some());
        let local_kept = super::super::get_sync_row(&db, Table::Hosts, &kept)
            .unwrap()
            .unwrap();
        let mut remote = host(&kept, &vault, "new");
        remote.auth_type = Some("password".into());
        remote.tags = Some("[]".into());
        remote.created_at = "2026-01-01T00:00:00.000Z".into();
        remote.edited_at = local_kept.edited_at.clone();
        remote.updated_at = remote.edited_at.clone();
        remote.device_id = local_kept.device_id.clone();
        remote.operation_id = local_kept.operation_id.clone();
        let event = PullChange {
            cursor: 3,
            table: "hosts".into(),
            record: record_value(Table::Hosts, &remote).unwrap(),
        };
        apply_pull_page_with_rotation(&db, &vault, &[event], 3, false, false, 2).unwrap();
        assert_eq!(
            super::super::get_sync_row(&db, Table::Hosts, &kept)
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("new")
        );
        assert!(super::super::get_sync_row(&db, Table::Hosts, &stale)
            .unwrap()
            .is_none());
        assert!(super::super::get_sync_row(&db, Table::Hosts, &pending)
            .unwrap()
            .is_some());
        assert_eq!(pending_count(&db, &vault).unwrap(), 1);
    }

    #[test]
    fn sync_db_remote_loser_keeps_local_outbox() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        let local =
            super::super::upsert_sync_row(&db, Table::Hosts, &host(&id, &vault, "local")).unwrap();
        let mut remote = local.clone();
        remote.name = Some("old remote".into());
        remote.edited_at = "2000-01-01T00:00:00.000Z".into();
        remote.updated_at = remote.edited_at.clone();
        remote.operation_id = Uuid::new_v4().to_string();
        apply_pull_page(
            &db,
            &vault,
            &[PullChange {
                cursor: 1,
                table: "hosts".into(),
                record: record_value(Table::Hosts, &remote).unwrap(),
            }],
            1,
        )
        .unwrap();
        assert_eq!(
            super::super::get_sync_row(&db, Table::Hosts, &id)
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("local")
        );
        assert_eq!(pending_batch(&db, &vault, 10).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod vault_delete_tests {
    use super::*;
    use uuid::Uuid;

    fn seal(table: &str) -> String {
        serde_json::json!({"v":1,"alg":"xchacha20poly1305","nonce":BASE64.encode([0u8;24]),"ct":BASE64.encode([0u8;32]),"aad":BASE64.encode(table)}).to_string()
    }

    #[test]
    fn sync_db_local_only_vault_delete_keeps_recoverable_rows_without_upload() {
        let path =
            std::env::temp_dir().join(format!("termvault-cancelled-vault-{}.db", Uuid::new_v4()));
        let path_str = path.to_str().unwrap();
        let vault = Uuid::new_v4().to_string();
        let host = Uuid::new_v4().to_string();
        let device = Uuid::new_v4().to_string();
        let db = super::super::open(path_str).unwrap();
        super::super::local_mutate(
            &db,
            Table::Vaults,
            &SyncRow {
                id: vault.clone(),
                owner_id: Some(Uuid::new_v4().to_string()),
                kind: Some("personal".into()),
                name: Some("Temporary".into()),
                data: "{}".into(),
                ..Default::default()
            },
            &device,
        )
        .unwrap();
        super::super::local_mutate(
            &db,
            Table::Hosts,
            &SyncRow {
                id: host.clone(),
                vault_id: vault.clone(),
                name: Some("host".into()),
                data: seal("hosts"),
                ..Default::default()
            },
            &device,
        )
        .unwrap();
        super::super::tombstone_vault_with_descendants(&db, &vault, &device).unwrap();
        assert!(is_cancelled_vault(&db, &vault).unwrap());
        assert_eq!(pending_count(&db, &vault).unwrap(), 0);
        assert!(pending_batch(&db, &vault, 10).unwrap().is_empty());
        assert!(super::super::get_sync_row(&db, Table::Vaults, &vault)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
        assert!(super::super::get_sync_row(&db, Table::Hosts, &host)
            .unwrap()
            .unwrap()
            .deleted_at
            .is_some());
        drop(db);
        let reopened = super::super::open(path_str).unwrap();
        assert!(is_cancelled_vault(&reopened, &vault).unwrap());
        assert_eq!(pending_count(&reopened, &vault).unwrap(), 0);
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn sync_db_vault_tombstone_waits_for_descendant_ack() {
        let db = super::super::open(":memory:").unwrap();
        let vault = Uuid::new_v4().to_string();
        let host = Uuid::new_v4().to_string();
        let device = Uuid::new_v4().to_string();
        let vault_row = SyncRow {
            id: vault.clone(),
            owner_id: Some(Uuid::new_v4().to_string()),
            name: Some("Personal".into()),
            kind: Some("personal".into()),
            data: "{}".into(),
            ..Default::default()
        };
        let host_row = SyncRow {
            id: host.clone(),
            vault_id: vault.clone(),
            name: Some("host".into()),
            data: seal("hosts"),
            ..Default::default()
        };
        super::super::local_mutate(&db, Table::Vaults, &vault_row, &device).unwrap();
        super::super::local_mutate(&db, Table::Hosts, &host_row, &device).unwrap();
        let vault_create = pending_batch(&db, &vault, 10).unwrap()[0].clone();
        assert_eq!(vault_create.table, "vaults");
        ack_push_results(
            &db,
            &vault,
            &[PushResult {
                operation_id: vault_create.operation_id,
                fate: "accepted".into(),
                canonical_record: vault_create.record,
                cursor: 1,
            }],
        )
        .unwrap();
        assert!(is_known_vault(&db, &vault).unwrap());
        super::super::tombstone_vault_with_descendants(&db, &vault, &device).unwrap();
        let batch = pending_batch(&db, &vault, 10).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].table, "hosts");
        assert_eq!(batch[0].record["deleted_at"].as_str().unwrap().len(), 24);
        let sent = batch[0].clone();
        ack_push_results(
            &db,
            &vault,
            &[PushResult {
                operation_id: sent.operation_id,
                fate: "accepted".into(),
                canonical_record: sent.record,
                cursor: 1,
            }],
        )
        .unwrap();
        let final_batch = pending_batch(&db, &vault, 10).unwrap();
        assert_eq!(final_batch.len(), 1);
        assert_eq!(final_batch[0].table, "vaults");
    }
}
