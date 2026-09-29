use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::Connection;
use std::sync::Mutex;

#[path = "sync_db.rs"]
pub mod sync_db;

pub const DB_FILE_NAME: &str = "termvault.db";

/// Reset the local database contents to pristine state. Row-deletion is used
/// instead of file removal because the managed connection holds the DB file
/// open (Windows cannot delete an open file). Does not VACUUM — file size is
/// retained, data is gone.
pub fn wipe_all(db: &LocalDb) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for table in [
        "port_forwards",
        "user_profiles",
        "user_keys",
        "vaults",
        "groups",
        "hosts",
        "keys",
        "snippets",
        "workspaces",
        "presets",
        "outbox",
        "sync_conflicts",
        "__sync_meta",
    ] {
        conn.execute_batch(&format!("DELETE FROM {table};"))
            .map_err(|e| format!("wipe_all: {table}: {e}"))?;
    }
    Ok(())
}

pub struct LocalDb {
    pub conn: Mutex<Connection>,
}

/// Open (or create) the local SQLite database and ensure all tables exist.
pub fn open(path: &str) -> Result<LocalDb, String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open DB: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set pragmas: {e}"))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_profiles (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            auth_provider TEXT NOT NULL DEFAULT 'password',
            provider_sub TEXT,
            salt_cl TEXT,
            kdf_m INTEGER NOT NULL DEFAULT 67108864,
            kdf_t INTEGER NOT NULL DEFAULT 3,
            kdf_p INTEGER NOT NULL DEFAULT 1,
            public_key TEXT,
            initialized INTEGER NOT NULL DEFAULT 0,
            last_login_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            key_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, key_type)
        );

        CREATE TABLE IF NOT EXISTS vaults (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            owner_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_default INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );

        -- Synced tables: shared envelope (id, revision, vault_id, created_at,
        -- updated_at, deleted_at) + plaintext whitelist columns + opaque encrypted
        -- data blob (AEAD with AAD = table name). No SQL FK constraints: rows can
        -- arrive via sync in any order (hydration without transient failures).
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            parent_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_groups_vault_parent ON groups(vault_id, parent_id, sort_order);

        CREATE TABLE IF NOT EXISTS hosts (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            os TEXT,
            auth_type TEXT NOT NULL DEFAULT 'password',
            tags TEXT NOT NULL DEFAULT '[]',
            color TEXT,
            group_id TEXT,
            key_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_hosts_vault_group ON hosts(vault_id, group_id, sort_order);

        CREATE TABLE IF NOT EXISTS port_forwards (
            id TEXT PRIMARY KEY,
            host_id TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('local', 'remote', 'dynamic')),
            name TEXT NOT NULL,
            local_port INTEGER,
            remote_bind_address TEXT,
            remote_port INTEGER,
            destination_host TEXT,
            destination_port INTEGER,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
            updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_port_forwards_host ON port_forwards(host_id);

        CREATE TABLE IF NOT EXISTS keys (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            description TEXT,
            key_type TEXT NOT NULL DEFAULT 'ed25519',
            fingerprint TEXT,
            public_key TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_keys_vault ON keys(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            description TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_snippets_vault ON snippets(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_vault ON workspaces(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS presets (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_presets_vault ON presets(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS outbox (
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            queued_at TEXT NOT NULL,
            vault_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            edited_at TEXT NOT NULL DEFAULT '',
            generation INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (table_name, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_queued_at ON outbox(queued_at);

        CREATE TABLE IF NOT EXISTS sync_conflicts (
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            remote_rev INTEGER NOT NULL,
            remote_payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (table_name, record_id)
        );

        CREATE TABLE IF NOT EXISTS sync_known_vaults (vault_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS sync_cancelled_vaults (vault_id TEXT PRIMARY KEY);

        CREATE TABLE IF NOT EXISTS __sync_meta (
            vault_id TEXT PRIMARY KEY,
            watermark INTEGER NOT NULL DEFAULT 0,
            cursor INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            last_device_id TEXT
);
        ",
    )
    .map_err(|e| format!("Failed to create tables: {e}"))?;
    migrate_add_columns(&conn)?;
    migrate_timestamps(&conn)?;
    migrate_sync_schema(&conn)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS sync_known_vaults (vault_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS sync_cancelled_vaults (vault_id TEXT PRIMARY KEY);")
        .map_err(|e| format!("migrate vault sync markers: {e}"))?;
    migrate_port_forward_fk(&conn)?;
    Ok(LocalDb {
        conn: Mutex::new(conn),
    })
}

/// Add columns introduced after the initial DDL to pre-existing databases.
/// Column presence is checked per table via PRAGMA table_info, so this is
/// idempotent and needs no version bookkeeping.
fn migrate_add_columns(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str, &str)] = &[
        ("hosts", "auth_type", "TEXT NOT NULL DEFAULT 'password'"),
        ("hosts", "tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("hosts", "color", "TEXT"),
        ("keys", "key_type", "TEXT NOT NULL DEFAULT 'ed25519'"),
        ("keys", "fingerprint", "TEXT"),
        ("keys", "public_key", "TEXT"),
        ("snippets", "tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("vaults", "revision", "INTEGER NOT NULL DEFAULT 1"),
        ("vaults", "vault_id", "TEXT NOT NULL DEFAULT ''"),
        ("vaults", "deleted_at", "INTEGER"),
        ("vaults", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("vaults", "is_default", "INTEGER NOT NULL DEFAULT 0"),
        ("vaults", "data", "TEXT NOT NULL DEFAULT '{}'"),
    ];
    for (table, column, ddl) in COLUMNS {
        let has: bool = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| format!("migrate table_info {table}: {e}"))?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("migrate table_info {table}: {e}"))?
            .filter_map(|r| r.ok())
            .any(|name| name == *column);
        if !has {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl};"))
                .map_err(|e| format!("migrate ADD COLUMN {table}.{column}: {e}"))?;
        }
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(names.iter().any(|name| name == column))
}

fn has_table(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |r| r.get::<_, bool>(0),
    )
    .map_err(|e| e.to_string())
}

fn migrate_sync_schema(conn: &Connection) -> Result<(), String> {
    if has_table(conn, "port_forwards")? {
        for (column, ddl) in [
            ("revision", "INTEGER NOT NULL DEFAULT 1"),
            ("vault_id", "TEXT NOT NULL DEFAULT ''"),
            (
                "created_at",
                "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
            ),
            (
                "updated_at",
                "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
            ),
            ("deleted_at", "TEXT"),
            ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
            ("data", "TEXT NOT NULL DEFAULT '{}'"),
        ] {
            if !has_column(conn, "port_forwards", column)? {
                conn.execute_batch(&format!(
                    "ALTER TABLE port_forwards ADD COLUMN {column} {ddl};"
                ))
                .map_err(|e| format!("migrate port_forwards.{column}: {e}"))?;
            }
        }
        conn.execute("UPDATE port_forwards SET vault_id = (SELECT vault_id FROM hosts WHERE hosts.id = port_forwards.host_id) WHERE vault_id = ''", [])
        .map_err(|e| format!("migrate port forward vault: {e}"))?;
    }
    for table in [
        "vaults",
        "groups",
        "hosts",
        "keys",
        "snippets",
        "workspaces",
        "presets",
        "port_forwards",
    ] {
        if !has_table(conn, table)? {
            continue;
        }
        for column in ["edited_at", "device_id", "operation_id"] {
            if !has_column(conn, table, column)? {
                conn.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT '';"
                ))
                .map_err(|e| format!("migrate {table}.{column}: {e}"))?;
            }
        }
        conn.execute(
            &format!("UPDATE {table} SET edited_at = updated_at WHERE edited_at = ''"),
            [],
        )
        .map_err(|e| format!("migrate {table}.edited_at: {e}"))?;
    }
    for (column, ddl) in [
        ("vault_id", "TEXT NOT NULL DEFAULT ''"),
        ("operation_id", "TEXT NOT NULL DEFAULT ''"),
        ("device_id", "TEXT NOT NULL DEFAULT ''"),
        ("edited_at", "TEXT NOT NULL DEFAULT ''"),
        ("generation", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        if !has_column(conn, "outbox", column)? {
            conn.execute_batch(&format!("ALTER TABLE outbox ADD COLUMN {column} {ddl};"))
                .map_err(|e| format!("migrate outbox.{column}: {e}"))?;
        }
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_record ON outbox(table_name, record_id);",
    )
    .map_err(|e| format!("migrate outbox uniqueness: {e}"))?;
    if has_table(conn, "__sync_meta")? && !has_column(conn, "__sync_meta", "cursor")? {
        conn.execute_batch("ALTER TABLE __sync_meta ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0;")
            .map_err(|e| e.to_string())?;
    }
    let mut stmt = conn.prepare("SELECT table_name, record_id, CAST(queued_at AS TEXT), vault_id, operation_id FROM outbox")
        .map_err(|e| e.to_string())?;
    let legacy = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (table_name, record_id, queued_at, vault_id, operation_id) in legacy {
        let table = Table::parse(&table_name)?;
        let row =
            get_sync_row_unlocked(conn, table, &record_id)?.ok_or("legacy outbox row missing")?;
        let vault = if vault_id.is_empty() {
            if table == Table::Vaults {
                record_id.clone()
            } else {
                row.vault_id.clone()
            }
        } else {
            vault_id
        };
        let op = if operation_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            operation_id
        };
        let stamp = canonical_utc_millis(&queued_at)?;
        conn.execute("UPDATE outbox SET queued_at = ?1, vault_id = ?2, operation_id = ?3, edited_at = ?4 WHERE table_name = ?5 AND record_id = ?6",
            rusqlite::params![stamp, vault, op, row.updated_at, table_name, record_id]).map_err(|e| e.to_string())?;
        conn.execute(
            &format!(
                "UPDATE {} SET operation_id = ?1, edited_at = updated_at WHERE id = ?2",
                table.as_str()
            ),
            rusqlite::params![op, record_id],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS sync_known_vaults (vault_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS sync_cancelled_vaults (vault_id TEXT PRIMARY KEY);")
        .map_err(|e| format!("migrate vault sync markers: {e}"))?;
    Ok(())
}

/// Legacy forwarding rows had an ON DELETE CASCADE host foreign key. Sync
/// needs to hydrate records in any order and retain tombstones after host edits.
fn migrate_port_forward_fk(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_list(port_forwards)")
        .map_err(|e| e.to_string())?;
    let has_fk = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .next()
        .transpose()
        .map_err(|e| e.to_string())?
        .is_some();
    drop(stmt);
    if !has_fk {
        return Ok(());
    }
    conn.execute_batch("PRAGMA foreign_keys=OFF;")
        .map_err(|e| e.to_string())?;
    let migration = conn.execute_batch(
        "BEGIN IMMEDIATE;
        CREATE TABLE port_forwards_no_fk (
            id TEXT PRIMARY KEY, host_id TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('local', 'remote', 'dynamic')),
            name TEXT NOT NULL, local_port INTEGER, remote_bind_address TEXT,
            remote_port INTEGER, destination_host TEXT, destination_port INTEGER,
            revision INTEGER NOT NULL DEFAULT 1, vault_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
            edited_at TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '',
            operation_id TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO port_forwards_no_fk
            (id, host_id, mode, name, local_port, remote_bind_address, remote_port,
             destination_host, destination_port, revision, vault_id, created_at,
             updated_at, deleted_at, edited_at, device_id, operation_id, sort_order, data)
        SELECT id, host_id, mode, name, local_port, remote_bind_address, remote_port,
             destination_host, destination_port, revision, vault_id, created_at,
             updated_at, deleted_at, edited_at, device_id, operation_id, sort_order, data
        FROM port_forwards;
        DROP TABLE port_forwards;
        ALTER TABLE port_forwards_no_fk RENAME TO port_forwards;
        CREATE INDEX IF NOT EXISTS idx_port_forwards_host ON port_forwards(host_id);
        COMMIT;",
    );
    if let Err(err) = migration {
        let _ = conn.execute_batch("ROLLBACK;");
        let _ = conn.execute_batch("PRAGMA foreign_keys=ON;");
        return Err(format!("migrate port forward foreign key: {err}"));
    }
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| e.to_string())?;
    Ok(())
}

const ENVELOPE_COLS: &str = "id, revision, vault_id, created_at, updated_at, deleted_at, edited_at, device_id, operation_id";

const ENVELOPE_COLS_SELECT: &str = ENVELOPE_COLS;

#[rustfmt::skip]
fn table_cols(table: Table) -> &'static str {
    match table {
        Table::Vaults     => "owner_id, kind, name, sort_order, is_default, data",
        Table::Groups     => "name, parent_id, sort_order, data",
        Table::Hosts      => "name, os, auth_type, tags, color, group_id, key_id, sort_order, data",
        Table::Keys       => "name, description, key_type, fingerprint, public_key, sort_order, data",
        Table::Snippets   => "name, description, tags, sort_order, data",
        Table::Workspaces => "name, sort_order, data",
        Table::Presets    => "name, sort_order, data",
        Table::PortForwards => "host_id, mode, name, sort_order, data",
    }
}

/// Normalize legacy SQLite epochs and server date strings to fixed-width UTC ISO milliseconds.
pub fn canonical_utc_millis(input: &str) -> Result<String, String> {
    let input = input.trim();
    let parsed = if let Ok(n) = input.parse::<i64>() {
        let millis = if input.len() <= 10 {
            n.checked_mul(1000).ok_or("timestamp overflow")?
        } else {
            n
        };
        Utc.timestamp_millis_opt(millis)
            .single()
            .ok_or("timestamp out of range")?
    } else if let Ok(date) = DateTime::parse_from_rfc3339(input) {
        date.with_timezone(&Utc)
    } else if let Ok(date) = NaiveDateTime::parse_from_str(input, "%Y-%m-%d %H:%M:%S%.f") {
        date.and_utc()
    } else if let Ok(date) = NaiveDate::parse_from_str(input, "%Y-%m-%d") {
        date.and_hms_opt(0, 0, 0).ok_or("invalid date")?.and_utc()
    } else {
        return Err(format!("unsupported timestamp: {input}"));
    };
    Ok(parsed.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn migrate_timestamps(conn: &Connection) -> Result<(), String> {
    for (table, columns) in [
        ("vaults", &["created_at", "updated_at", "deleted_at"][..]),
        ("groups", &["created_at", "updated_at", "deleted_at"]),
        ("hosts", &["created_at", "updated_at", "deleted_at"]),
        ("keys", &["created_at", "updated_at", "deleted_at"]),
        ("snippets", &["created_at", "updated_at", "deleted_at"]),
        ("workspaces", &["created_at", "updated_at", "deleted_at"]),
        ("presets", &["created_at", "updated_at", "deleted_at"]),
        (
            "user_profiles",
            &["created_at", "updated_at", "last_login_at"],
        ),
        ("user_keys", &["created_at"]),
    ] {
        for column in columns {
            let sql = format!(
                "SELECT rowid, CAST({column} AS TEXT) FROM {table} WHERE {column} IS NOT NULL"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("migrate {table}.{column}: {e}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            drop(stmt);
            for (rowid, old) in rows {
                let canonical = canonical_utc_millis(&old)?;
                if canonical != old {
                    conn.execute(
                        &format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"),
                        rusqlite::params![canonical, rowid],
                    )
                    .map_err(|e| format!("migrate {table}.{column}: {e}"))?;
                }
            }
        }
    }
    Ok(())
}

fn row_vals(row: &SyncRow, cols: &str) -> Vec<rusqlite::types::Value> {
    let mut v = vec![
        row.id.clone().into(),
        row.revision.into(),
        row.vault_id.clone().into(),
        row.created_at.clone().into(),
        row.updated_at.clone().into(),
        row.deleted_at.clone().into(),
        row.edited_at.clone().into(),
        row.device_id.clone().into(),
        row.operation_id.clone().into(),
    ];
    let add = |v: &mut Vec<rusqlite::types::Value>, val: Option<&String>| {
        v.push(
            val.map(|s| s.clone().into())
                .unwrap_or(rusqlite::types::Value::Null),
        );
    };
    match cols {
        "owner_id, kind, name, sort_order, is_default, data" => {
            add(&mut v, row.owner_id.as_ref());
            add(&mut v, row.kind.as_ref());
            add(&mut v, row.name.as_ref());
            v.push(row.sort_order.into());
            v.push(row.is_default.into());
            v.push(row.data.clone().into());
        }
        "host_id, mode, name, sort_order, data" => {
            add(&mut v, row.host_id.as_ref());
            add(&mut v, row.mode.as_ref());
            add(&mut v, row.name.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
        "name, parent_id, sort_order, data" => {
            add(&mut v, row.name.as_ref());
            add(&mut v, row.parent_id.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
        "name, os, auth_type, tags, color, group_id, key_id, sort_order, data" => {
            add(&mut v, row.name.as_ref());
            add(&mut v, row.os.as_ref());
            add(&mut v, row.auth_type.as_ref());
            add(&mut v, row.tags.as_ref());
            add(&mut v, row.color.as_ref());
            add(&mut v, row.group_id.as_ref());
            add(&mut v, row.key_id.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
        "name, description, key_type, fingerprint, public_key, sort_order, data" => {
            add(&mut v, row.name.as_ref());
            add(&mut v, row.description.as_ref());
            add(&mut v, row.key_type.as_ref());
            add(&mut v, row.fingerprint.as_ref());
            add(&mut v, row.public_key.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
        "name, description, tags, sort_order, data" => {
            add(&mut v, row.name.as_ref());
            add(&mut v, row.description.as_ref());
            add(&mut v, row.tags.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
        _ => {
            add(&mut v, row.name.as_ref());
            v.push(row.sort_order.into());
            v.push(row.data.clone().into());
        }
    }
    v
}

fn row_from(_table: Table, row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncRow> {
    // Envelope by position (0-5); whitelist columns by name — rusqlite resolves
    // named columns at query time, so optional columns absent from a table are
    // read as None via .ok() (get by name errors when the name is not in the
    // result set).
    let opt = |name: &str| -> Option<String> { row.get::<_, Option<String>>(name).ok().flatten() };
    Ok(SyncRow {
        id: row.get(0)?,
        revision: row.get(1)?,
        vault_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
        edited_at: row.get(6)?,
        device_id: row.get(7)?,
        operation_id: row.get(8)?,
        name: opt("name"),
        host_id: opt("host_id"),
        mode: opt("mode"),
        os: opt("os"),
        auth_type: opt("auth_type"),
        tags: opt("tags"),
        color: opt("color"),
        description: opt("description"),
        key_type: opt("key_type"),
        fingerprint: opt("fingerprint"),
        public_key: opt("public_key"),
        owner_id: opt("owner_id"),
        kind: opt("kind"),
        group_id: opt("group_id"),
        parent_id: opt("parent_id"),
        key_id: opt("key_id"),
        sort_order: row
            .get::<_, Option<i64>>("sort_order")
            .ok()
            .flatten()
            .unwrap_or(0),
        is_default: row
            .get::<_, Option<i64>>("is_default")
            .ok()
            .flatten()
            .unwrap_or(0),
        data: row.get("data")?,
    })
}

impl Table {
    pub fn parse(s: &str) -> Result<Table, String> {
        match s {
            "vaults" => Ok(Table::Vaults),
            "groups" => Ok(Table::Groups),
            "hosts" => Ok(Table::Hosts),
            "keys" => Ok(Table::Keys),
            "snippets" => Ok(Table::Snippets),
            "workspaces" => Ok(Table::Workspaces),
            "presets" => Ok(Table::Presets),
            "port_forwards" => Ok(Table::PortForwards),
            other => Err(format!("unknown table: {other}")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Table::Vaults => "vaults",
            Table::Groups => "groups",
            Table::Hosts => "hosts",
            Table::Keys => "keys",
            Table::Snippets => "snippets",
            Table::Workspaces => "workspaces",
            Table::Presets => "presets",
            Table::PortForwards => "port_forwards",
        }
    }
}

pub fn upsert_sync_row(db: &LocalDb, table: Table, row: &SyncRow) -> Result<SyncRow, String> {
    let device = if row.device_id.is_empty() {
        uuid::Uuid::nil().to_string()
    } else {
        row.device_id.clone()
    };
    local_mutate(db, table, row, &device)
}

/// Save a local edit and its durable operation in the same SQLite transaction.
pub fn local_mutate(
    db: &LocalDb,
    table: Table,
    row: &SyncRow,
    device_id: &str,
) -> Result<SyncRow, String> {
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let existing = get_sync_row_unlocked(&conn, table, &row.id)?;
    let mut out = row.clone();
    out.revision = existing.as_ref().map_or(1, |r| r.revision + 1);
    let now = now_iso();
    out.created_at = existing
        .as_ref()
        .map_or_else(|| now.clone(), |r| r.created_at.clone());
    out.updated_at = now.clone();
    out.edited_at = now.clone();
    out.device_id = device_id.to_string();
    out.operation_id = uuid::Uuid::new_v4().to_string();
    out.deleted_at = None;
    if table == Table::Hosts {
        out.auth_type.get_or_insert_with(|| "password".to_string());
        out.tags.get_or_insert_with(|| "[]".to_string());
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("local_mutate tx: {e}"))?;
    sync_db::write_row(&tx, table, &out)?;
    sync_db::queue_row(&tx, table, &out, &now)?;
    if table == Table::Vaults {
        if out.is_default != 0 {
            tx.execute(
                "INSERT OR IGNORE INTO sync_known_vaults (vault_id) VALUES (?1)",
                [&out.id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "DELETE FROM sync_cancelled_vaults WHERE vault_id = ?1",
            [&out.id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit()
        .map_err(|e| format!("local_mutate commit: {e}"))?;
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutboxEntry {
    pub table_name: String,
    pub record_id: String,
    pub queued_at: String,
    pub vault_id: String,
    pub operation_id: String,
    pub device_id: String,
    pub edited_at: String,
    pub generation: i64,
}

pub fn tombstone_sync_row(db: &LocalDb, table: Table, id: &str) -> Result<(), String> {
    tombstone_sync_row_with_device(db, table, id, &uuid::Uuid::nil().to_string())
}

pub fn tombstone_sync_row_with_device(
    db: &LocalDb,
    table: Table,
    id: &str,
    device_id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let Some(existing) = get_sync_row_unlocked(&conn, table, id)? else {
        return Ok(());
    };
    if existing.deleted_at.is_some() {
        return Ok(());
    }
    let now = now_iso();
    let mut tombstone = existing;
    tombstone.revision += 1;
    tombstone.updated_at = now.clone();
    tombstone.edited_at = now.clone();
    tombstone.deleted_at = Some(now.clone());
    tombstone.device_id = device_id.to_string();
    tombstone.operation_id = uuid::Uuid::new_v4().to_string();
    let tx = conn
        .transaction()
        .map_err(|e| format!("tombstone tx: {e}"))?;
    sync_db::write_row(&tx, table, &tombstone)?;
    sync_db::queue_row(&tx, table, &tombstone, &now)?;
    tx.commit().map_err(|e| format!("tombstone commit: {e}"))
}

/// Tombstone a vault and every synced descendant atomically. The outbox sends
/// descendants before the vault tombstone so the server never strands live rows.
pub fn tombstone_vault_with_descendants(
    db: &LocalDb,
    vault_id: &str,
    device_id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let vault = get_sync_row_unlocked(&tx, Table::Vaults, vault_id)?;
    let Some(vault) = vault else {
        return Ok(());
    };
    let known: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_known_vaults WHERE vault_id = ?1)",
            [vault_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let local_only = !known && vault.is_default == 0;
    let now = now_iso();
    for table in [
        Table::PortForwards,
        Table::Hosts,
        Table::Groups,
        Table::Keys,
        Table::Snippets,
        Table::Workspaces,
        Table::Presets,
        Table::Vaults,
    ] {
        let ids = if table == Table::Vaults {
            vec![vault_id.to_string()]
        } else {
            let mut stmt = tx
                .prepare(&format!(
                    "SELECT id FROM {} WHERE vault_id = ?1 AND deleted_at IS NULL",
                    table.as_str()
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([vault_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for id in ids {
            let Some(mut row) = get_sync_row_unlocked(&tx, table, &id)? else {
                continue;
            };
            if row.deleted_at.is_some() {
                continue;
            }
            if table != Table::Vaults && row.vault_id != vault_id {
                return Err("vault descendant mismatch".into());
            }
            row.revision += 1;
            row.updated_at = now.clone();
            row.edited_at = now.clone();
            row.deleted_at = Some(now.clone());
            row.device_id = device_id.to_string();
            row.operation_id = uuid::Uuid::new_v4().to_string();
            sync_db::write_row(&tx, table, &row)?;
            sync_db::queue_row(&tx, table, &row, &now)?;
        }
    }
    if local_only {
        // Preserve encrypted rows and operations for recovery, while avoiding
        // uploads to a vault the server has never seen.
        tx.execute(
            "INSERT OR IGNORE INTO sync_cancelled_vaults (vault_id) VALUES (?1)",
            [vault_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn outbox_pending(db: &LocalDb) -> Result<Vec<OutboxEntry>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT table_name, record_id, queued_at, vault_id, operation_id, device_id, edited_at, generation FROM outbox WHERE vault_id NOT IN (SELECT vault_id FROM sync_cancelled_vaults) ORDER BY queued_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(OutboxEntry {
                table_name: r.get(0)?,
                record_id: r.get(1)?,
                queued_at: r.get(2)?,
                vault_id: r.get(3)?,
                operation_id: r.get(4)?,
                device_id: r.get(5)?,
                edited_at: r.get(6)?,
                generation: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();
    Ok(rows)
}

// used by the Plan #4 sync engine and db tests
#[allow(dead_code)]
pub fn outbox_remove(db: &LocalDb, table: Table, id: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM outbox WHERE table_name = ?1 AND record_id = ?2",
        rusqlite::params![table.as_str(), id],
    )
    .map_err(|e| format!("outbox_remove: {e}"))?;
    Ok(())
}

pub fn get_sync_row(db: &LocalDb, table: Table, id: &str) -> Result<Option<SyncRow>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_sync_row_unlocked(&conn, table, id)
}

pub fn update_host_os(db: &LocalDb, host_id: &str, os: &str) -> Result<(), String> {
    update_host_os_with_device(db, host_id, os, &uuid::Uuid::nil().to_string())
}

pub fn update_host_os_with_device(
    db: &LocalDb,
    host_id: &str,
    os: &str,
    device_id: &str,
) -> Result<(), String> {
    let Some(mut row) = get_sync_row(db, Table::Hosts, host_id)? else {
        return Ok(());
    };
    row.os = Some(os.to_string());
    local_mutate(db, Table::Hosts, &row, device_id)?;
    Ok(())
}

fn get_sync_row_unlocked(
    conn: &Connection,
    table: Table,
    id: &str,
) -> Result<Option<SyncRow>, String> {
    let cols = table_cols(table);
    let sql = format!(
        "SELECT {envelope}, {cols} FROM {t} WHERE id = ?1",
        envelope = ENVELOPE_COLS_SELECT,
        t = table.as_str(),
        cols = cols,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(rusqlite::params![id], |r| row_from(table, r))
        .map_err(|e| e.to_string())?;
    Ok(rows.next().transpose().map_err(|e| e.to_string())?)
}

pub fn list_sync_rows(
    db: &LocalDb,
    table: Table,
    vault_id: &str,
    include_deleted: bool,
) -> Result<Vec<SyncRow>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let cols = table_cols(table);
    // Vaults are per-user, not per-vault: skip the vault_id filter for them.
    let vid: Option<&str> = match (include_deleted, table == Table::Vaults) {
        (true, true) => None,
        (true, false) => Some(vault_id),
        (false, true) => None,
        (false, false) => Some(vault_id),
    };
    let where_clause = if vid.is_some() {
        if include_deleted {
            "WHERE vault_id = ?1"
        } else {
            "WHERE deleted_at IS NULL AND vault_id = ?1"
        }
    } else if !include_deleted {
        "WHERE deleted_at IS NULL"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {envelope}, {cols} FROM {t} {where_clause} ORDER BY sort_order, created_at DESC",
        envelope = ENVELOPE_COLS_SELECT,
        t = table.as_str(),
        cols = cols,
        where_clause = where_clause,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let vault_filter = vid.unwrap_or("");
    let params: Vec<&dyn rusqlite::ToSql> = if vid.is_some() {
        vec![&vault_filter]
    } else {
        vec![]
    };
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |r| row_from(table, r))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("list_sync_rows({}): {e}", table.as_str()))?;
    Ok(rows)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Vaults,
    Groups,
    Hosts,
    Keys,
    Snippets,
    Workspaces,
    Presets,
    PortForwards,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct SyncRow {
    pub id: String,
    pub revision: i64,
    pub vault_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub edited_at: String,
    pub device_id: String,
    pub operation_id: String,
    pub name: Option<String>,
    pub host_id: Option<String>,
    pub mode: Option<String>,
    pub os: Option<String>,
    pub auth_type: Option<String>,
    pub tags: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
    pub public_key: Option<String>,
    pub owner_id: Option<String>,
    pub kind: Option<String>,
    pub sort_order: i64,
    pub is_default: i64,
    pub parent_id: Option<String>,
    pub group_id: Option<String>,
    pub key_id: Option<String>,
    pub data: String,
}

/// Reorder rows through the same durable local-mutation path as ordinary edits.
pub fn update_sort_orders(
    db: &LocalDb,
    table: Table,
    updates: &[(String, i64)],
) -> Result<(), String> {
    update_sort_orders_with_device(db, table, updates, &uuid::Uuid::nil().to_string())
}

pub fn update_sort_orders_with_device(
    db: &LocalDb,
    table: Table,
    updates: &[(String, i64)],
    device_id: &str,
) -> Result<(), String> {
    for (id, order) in updates {
        if let Some(mut row) = get_sync_row(db, table, id)? {
            row.sort_order = *order;
            local_mutate(db, table, &row, device_id)?;
        }
    }
    Ok(())
}

pub fn update_host_group(db: &LocalDb, host_id: &str, group_id: &str) -> Result<(), String> {
    update_host_group_with_device(db, host_id, group_id, &uuid::Uuid::nil().to_string())
}

pub fn update_host_group_with_device(
    db: &LocalDb,
    host_id: &str,
    group_id: &str,
    device_id: &str,
) -> Result<(), String> {
    if let Some(mut row) = get_sync_row(db, Table::Hosts, host_id)? {
        row.group_id = if group_id.is_empty() {
            None
        } else {
            Some(group_id.to_string())
        };
        local_mutate(db, Table::Hosts, &row, device_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_db_migrates_legacy_outbox_to_stable_iso_operation() {
        let path = std::env::temp_dir().join(format!(
            "termvault-sync-migration-{}.db",
            uuid::Uuid::new_v4()
        ));
        let path_str = path.to_str().unwrap();
        let host_id = uuid::Uuid::new_v4().to_string();
        let vault_id = uuid::Uuid::new_v4().to_string();
        {
            let db = open(path_str).unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO hosts (id, vault_id, created_at, updated_at, name, data) VALUES (?1, ?2, '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.001Z', 'legacy', '{}')",
                rusqlite::params![host_id, vault_id]).unwrap();
            conn.execute("INSERT INTO outbox (table_name, record_id, queued_at) VALUES ('hosts', ?1, 1700000000000)", [&host_id]).unwrap();
        }
        let first = open(path_str).unwrap();
        let pending = outbox_pending(&first).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].queued_at, "2023-11-14T22:13:20.000Z");
        assert_eq!(pending[0].vault_id, vault_id);
        uuid::Uuid::parse_str(&pending[0].operation_id).unwrap();
        let operation_id = pending[0].operation_id.clone();
        drop(first);
        let second = open(path_str).unwrap();
        assert_eq!(
            outbox_pending(&second).unwrap()[0].operation_id,
            operation_id
        );
        drop(second);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn sync_db_migrates_forward_fk_without_losing_legacy_definition() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DROP TABLE port_forwards;
            CREATE TABLE port_forwards (
                id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
                mode TEXT NOT NULL, name TEXT NOT NULL, local_port INTEGER,
                remote_bind_address TEXT, remote_port INTEGER, destination_host TEXT, destination_port INTEGER
            );
            INSERT INTO hosts (id, vault_id, created_at, updated_at, name) VALUES
                ('legacy-host', 'legacy-vault', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'host');
            INSERT INTO port_forwards (id, host_id, mode, name, local_port) VALUES
                ('legacy-forward', 'legacy-host', 'dynamic', 'socks', 1080);")
            .unwrap();
        migrate_sync_schema(&conn).unwrap();
        migrate_port_forward_fk(&conn).unwrap();
        conn.execute("DELETE FROM hosts WHERE id = 'legacy-host'", [])
            .unwrap();
        let port: i64 = conn
            .query_row(
                "SELECT local_port FROM port_forwards WHERE id = 'legacy-forward'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(port, 1080);
        migrate_port_forward_fk(&conn).unwrap();
    }

    #[test]
    fn canonical_utc_normalizes_offsets_and_epoch_millis() {
        assert_eq!(
            canonical_utc_millis("2026-09-27T06:00:00+06:00").unwrap(),
            "2026-09-27T00:00:00.000Z"
        );
        assert_eq!(
            canonical_utc_millis("1700000000000").unwrap(),
            "2023-11-14T22:13:20.000Z"
        );
    }

    #[test]
    fn canonical_utc_migrates_legacy_host_without_touching_ciphertext() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO hosts (id, vault_id, created_at, updated_at, name, data) VALUES ('legacy', 'v1', 1700000000000, 1700000000001, 'Legacy', 'sealed-blob')", []).unwrap();
        }
        migrate_timestamps(&db.conn.lock().unwrap()).unwrap();
        let conn = db.conn.lock().unwrap();
        let (created, updated, payload): (String, String, String) = conn
            .query_row(
                "SELECT created_at, updated_at, data FROM hosts WHERE id = 'legacy'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(created, "2023-11-14T22:13:20.000Z");
        assert_eq!(updated, "2023-11-14T22:13:20.001Z");
        assert_eq!(payload, "sealed-blob");
    }

    fn test_db() -> LocalDb {
        open(":memory:").unwrap()
    }

    #[test]
    fn test_open_creates_synced_tables() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for t in [
            "user_profiles",
            "user_keys",
            "vaults",
            "groups",
            "hosts",
            "keys",
            "snippets",
            "workspaces",
            "presets",
            "outbox",
            "sync_conflicts",
            "__sync_meta",
            "port_forwards",
        ] {
            assert!(tables.contains(&t.to_string()), "missing table {t}");
        }
        assert!(!tables.contains(&"records".to_string()));
    }

    #[test]
    fn test_migrate_adds_whitelist_columns_to_old_schema() {
        // Simulate a DB created before the plaintext whitelist columns existed:
        // old DDL only (no auth_type/tags/color/key_type/fingerprint/public_key).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE hosts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, os TEXT, group_id TEXT, key_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE keys (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE snippets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             -- old vaults schema: no sync envelope at all
             CREATE TABLE vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                kind TEXT NOT NULL, name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();

        migrate_add_columns(&conn).unwrap();

        for (table, column) in [
            ("hosts", "auth_type"),
            ("hosts", "tags"),
            ("hosts", "color"),
            ("keys", "key_type"),
            ("keys", "fingerprint"),
            ("keys", "public_key"),
            ("snippets", "tags"),
            ("vaults", "revision"),
            ("vaults", "vault_id"),
            ("vaults", "deleted_at"),
            ("vaults", "sort_order"),
            ("vaults", "is_default"),
            ("vaults", "data"),
        ] {
            let cols: Vec<String> = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            assert!(
                cols.contains(&column.to_string()),
                "missing {table}.{column}"
            );
        }
        // idempotent
        migrate_add_columns(&conn).unwrap();
    }

    #[test]
    fn test_wipe_all_clears_every_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hosts (id, revision, vault_id, created_at, updated_at, name, sort_order, data)
             VALUES ('h1', 1, 'v1', 1, 1, 'box', 0, '{}')", [],
        ).unwrap();
        conn.execute(
            "INSERT INTO outbox (table_name, record_id, queued_at) VALUES ('hosts', 'h1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO port_forwards (id, host_id, mode, name, local_port) VALUES ('f1', 'h1', 'dynamic', 'socks', 1080)", [],
        ).unwrap();
        drop(conn);
        wipe_all(&db).unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM hosts", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM port_forwards", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_upsert_group_roundtrip_and_revision_bump() {
        let db = test_db();
        let g1 = SyncRow {
            id: "g1".into(),
            revision: 99,
            vault_id: "v1".into(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("Servers".into()),
            os: None,
            auth_type: None,
            tags: None,
            color: None,
            description: None,
            key_type: None,
            fingerprint: None,
            public_key: None,
            owner_id: None,
            kind: None,
            sort_order: 0,
            is_default: 0,
            parent_id: None,
            group_id: None,
            key_id: None,
            data: "{}".into(),
        };
        let saved = upsert_sync_row(&db, Table::Groups, &g1).unwrap();
        assert_eq!(saved.revision, 1); // caller revision ignored
        assert_eq!(saved.vault_id, "v1");
        assert_eq!(saved.name.as_deref(), Some("Servers"));
        assert!(!saved.created_at.is_empty() && saved.updated_at >= saved.created_at);

        let updated = upsert_sync_row(&db, Table::Groups, &g1).unwrap();
        assert_eq!(updated.revision, 2); // bump on update
        assert_eq!(updated.created_at, saved.created_at); // preserved
    }

    #[test]
    fn test_upsert_host_roundtrip() {
        let db = test_db();
        let h = SyncRow {
            id: "h1".into(),
            revision: 1,
            vault_id: "v1".into(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("prod".into()),
            os: Some("linux".into()),
            auth_type: Some("password".into()),
            tags: Some("[\"web\",\"prod\"]".into()),
            color: Some("#ff0000".into()),
            description: None,
            key_type: None,
            fingerprint: None,
            public_key: None,
            owner_id: None,
            kind: None,
            sort_order: 3,
            is_default: 0,
            parent_id: None,
            group_id: Some("g1".into()),
            key_id: Some("k1".into()),
            data: "encrypted".into(),
        };
        upsert_sync_row(&db, Table::Hosts, &h).unwrap();
        let loaded = get_sync_row(&db, Table::Hosts, "h1").unwrap().unwrap();
        assert_eq!(loaded.name.as_deref(), Some("prod"));
        assert_eq!(loaded.group_id.as_deref(), Some("g1"));
        assert_eq!(loaded.os.as_deref(), Some("linux"));
        assert_eq!(loaded.auth_type.as_deref(), Some("password"));
        assert_eq!(loaded.tags.as_deref(), Some("[\"web\",\"prod\"]"));
        assert_eq!(loaded.color.as_deref(), Some("#ff0000"));
        assert_eq!(loaded.data, "encrypted"); // opaque passthrough
        assert_eq!(
            list_sync_rows(&db, Table::Hosts, "v1", false)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_host_edit_preserves_saved_port_forwards() {
        use crate::forwarding::{model::ForwardInput, storage};

        let db = test_db();
        let mut host = SyncRow {
            id: "h1".into(),
            revision: 1,
            vault_id: "v1".into(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("old".into()),
            os: None,
            auth_type: Some("password".into()),
            tags: Some("[]".into()),
            color: None,
            description: None,
            key_type: None,
            fingerprint: None,
            public_key: None,
            owner_id: None,
            kind: None,
            sort_order: 0,
            is_default: 0,
            parent_id: None,
            group_id: None,
            key_id: None,
            data: "{}".into(),
        };
        upsert_sync_row(&db, Table::Hosts, &host).unwrap();
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        let device_id = uuid::Uuid::new_v4().to_string();
        let forward = storage::create(
            &db,
            &session,
            &device_id,
            ForwardInput::local("h1", "web", 8080, "localhost", 80),
        )
        .unwrap();

        host.name = Some("renamed".into());
        upsert_sync_row(&db, Table::Hosts, &host).unwrap();

        let forwards = storage::list(&db, &session, &device_id, "h1").unwrap();
        assert_eq!(forwards.len(), 1);
        assert_eq!(forwards[0].id, forward.id);
    }

    #[test]
    fn test_list_scoped_to_vault_and_sorted() {
        let db = test_db();
        for (id, vault, order) in [("h1", "v1", 2), ("h2", "v1", 1), ("h3", "v2", 9)] {
            let h = SyncRow {
                id: id.into(),
                revision: 1,
                vault_id: vault.into(),
                created_at: "1".into(),
                updated_at: "1".into(),
                deleted_at: None,
                edited_at: String::new(),
                device_id: String::new(),
                operation_id: String::new(),
                host_id: None,
                mode: None,
                name: Some(id.into()),
                os: None,
                auth_type: None,
                tags: None,
                color: None,
                description: None,
                key_type: None,
                fingerprint: None,
                public_key: None,
                owner_id: None,
                kind: None,
                sort_order: order,
                is_default: 0,
                parent_id: None,
                group_id: None,
                key_id: None,
                data: "{}".into(),
            };
            upsert_sync_row(&db, Table::Hosts, &h).unwrap();
        }
        let v1 = list_sync_rows(&db, Table::Hosts, "v1", false).unwrap();
        assert_eq!(
            v1.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["h2", "h1"]
        );
    }

    #[test]
    fn test_tombstone_hides_row_and_bumps_outbox() {
        let db = test_db();
        let k = SyncRow {
            id: "k1".into(),
            revision: 1,
            vault_id: "v1".into(),
            created_at: "1".into(),
            updated_at: "1".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("key".into()),
            os: None,
            auth_type: None,
            tags: None,
            color: None,
            description: None,
            key_type: Some("ed25519".into()),
            fingerprint: Some("SHA256:abc".into()),
            public_key: Some("ssh-ed25519 AAAA".into()),
            owner_id: None,
            kind: None,
            sort_order: 0,
            is_default: 0,
            parent_id: None,
            group_id: None,
            key_id: None,
            data: "enc".into(),
        };
        upsert_sync_row(&db, Table::Keys, &k).unwrap();
        let loaded = get_sync_row(&db, Table::Keys, "k1").unwrap().unwrap();
        assert_eq!(loaded.key_type.as_deref(), Some("ed25519"));
        assert_eq!(loaded.fingerprint.as_deref(), Some("SHA256:abc"));
        assert_eq!(loaded.public_key.as_deref(), Some("ssh-ed25519 AAAA"));
        assert_eq!(
            list_sync_rows(&db, Table::Keys, "v1", false).unwrap().len(),
            1
        );

        tombstone_sync_row(&db, Table::Keys, "k1").unwrap();
        let all = list_sync_rows(&db, Table::Keys, "v1", true).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted_at.is_some() && all[0].revision == 2);
        assert_eq!(
            list_sync_rows(&db, Table::Keys, "v1", false).unwrap().len(),
            0
        );

        // idempotent: second tombstone does not bump again
        tombstone_sync_row(&db, Table::Keys, "k1").unwrap();
        let all2 = list_sync_rows(&db, Table::Keys, "v1", true).unwrap();
        assert_eq!(all2[0].revision, 2);

        let pending = outbox_pending(&db).unwrap();
        assert!(pending
            .iter()
            .any(|o| o.table_name == "keys" && o.record_id == "k1"));
    }

    #[test]
    fn test_outbox_remove_and_remaining_tables_roundtrip() {
        let db = test_db();
        for (table, id) in [
            (Table::Snippets, "s1"),
            (Table::Workspaces, "w1"),
            (Table::Presets, "p1"),
        ] {
            let row = SyncRow {
                id: id.into(),
                revision: 1,
                vault_id: "v1".into(),
                created_at: "1".into(),
                updated_at: "1".into(),
                deleted_at: None,
                edited_at: String::new(),
                device_id: String::new(),
                operation_id: String::new(),
                host_id: None,
                mode: None,
                name: Some("n".into()),
                os: None,
                auth_type: None,
                tags: Some("[\"t1\"]".into()),
                color: None,
                description: None,
                key_type: None,
                fingerprint: None,
                public_key: None,
                owner_id: None,
                kind: None,
                sort_order: 0,
                is_default: 0,
                parent_id: None,
                group_id: None,
                key_id: None,
                data: "enc".into(),
            };
            upsert_sync_row(&db, table, &row).unwrap();
        }
        let s1 = get_sync_row(&db, Table::Snippets, "s1").unwrap().unwrap();
        assert_eq!(s1.tags.as_deref(), Some("[\"t1\"]"));
        assert_eq!(
            list_sync_rows(&db, Table::Snippets, "v1", false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_sync_rows(&db, Table::Workspaces, "v1", false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_sync_rows(&db, Table::Presets, "v1", false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(outbox_pending(&db).unwrap().len(), 3);

        outbox_remove(&db, Table::Snippets, "s1").unwrap();
        let pending = outbox_pending(&db).unwrap();
        assert!(!pending.iter().any(|o| o.record_id == "s1"));
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn test_table_parse_rejects_unknown() {
        assert_eq!(Table::parse("hosts").unwrap(), Table::Hosts);
        assert!(Table::parse("hosts; DROP TABLE groups").is_err());
        assert!(Table::parse("HOSTS").is_err());
    }

    #[test]
    fn test_sync_row_deserializes_store_shapes() {
        let host = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "h1", "vault_id": "v1", "name": "prod",
            "auth_type": "key", "tags": "[\"web\"]", "color": "#0ff",
            "group_id": "g1", "key_id": "k1", "sort_order": 0, "data": "enc"
        }))
        .unwrap();
        assert_eq!(host.revision, 0);
        assert_eq!(host.created_at, "");
        assert_eq!(host.updated_at, "");
        assert!(host.deleted_at.is_none());
        assert_eq!(host.name.as_deref(), Some("prod"));
        assert!(host.os.is_none());
        assert_eq!(host.auth_type.as_deref(), Some("key"));
        assert_eq!(host.tags.as_deref(), Some("[\"web\"]"));
        assert_eq!(host.color.as_deref(), Some("#0ff"));
        assert_eq!(host.group_id.as_deref(), Some("g1"));
        assert_eq!(host.key_id.as_deref(), Some("k1"));
        assert_eq!(host.data, "enc");

        let key = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "k1", "vault_id": "v1", "name": "ssh",
            "description": "main", "key_type": "rsa", "fingerprint": "SHA256:x",
            "public_key": "ssh-rsa AAAA", "sort_order": 0, "data": "enc"
        }))
        .unwrap();
        assert_eq!(key.revision, 0);
        assert_eq!(key.description.as_deref(), Some("main"));
        assert_eq!(key.key_type.as_deref(), Some("rsa"));
        assert_eq!(key.fingerprint.as_deref(), Some("SHA256:x"));
        assert_eq!(key.public_key.as_deref(), Some("ssh-rsa AAAA"));
        assert!(key.group_id.is_none() && key.key_id.is_none());

        let snippet = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "s1", "vault_id": "v1", "name": "script",
            "description": "d", "sort_order": 0, "data": "enc"
        }))
        .unwrap();
        assert_eq!(snippet.revision, 0);
        assert_eq!(snippet.name.as_deref(), Some("script"));

        let workspace = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "w1", "vault_id": "v1", "name": "prod", "sort_order": 0, "data": "enc"
        }))
        .unwrap();
        assert_eq!(workspace.revision, 0);
        assert_eq!(workspace.updated_at, "");
        assert!(workspace.deleted_at.is_none());
        assert_eq!(workspace.data, "enc");
    }

    fn upsert_test_vault(db: &LocalDb, vault: &SyncRow) -> SyncRow {
        let mut row = vault.clone();
        row.vault_id = String::new();
        row.deleted_at = None;
        upsert_sync_row(db, Table::Vaults, &row).unwrap()
    }

    #[test]
    fn test_upsert_vault_roundtrip() {
        let db = test_db();
        let vault = SyncRow {
            id: "v1".into(),
            revision: 0,
            vault_id: String::new(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        let saved = upsert_test_vault(&db, &vault);
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.name.as_deref(), Some("Personal"));
        assert_eq!(saved.owner_id.as_deref(), Some("u1"));

        // user-created vaults are never the default (the server-seeded one is)
        assert_eq!(saved.is_default, 0);

        let (revision, deleted_at): (i64, Option<String>) = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT revision, deleted_at FROM vaults WHERE id = 'v1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(revision, 1);
        assert!(deleted_at.is_none());

        // vault writes hit the outbox like any sync row
        let outbox = outbox_pending(&db).unwrap();
        assert!(outbox
            .iter()
            .any(|o| o.table_name == "vaults" && o.record_id == "v1"));
    }

    #[test]
    fn test_vaults_readable_on_migrated_text_schema() {
        // Regression: live DBs created before the vault sync-envelope migration have
        // TEXT-affinity created_at/updated_at. New writes store epoch-ms as TEXT, so
        // list/get must CAST (a plain i64 read raises InvalidColumnType → empty lists).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE hosts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, os TEXT, group_id TEXT, key_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE keys (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE snippets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             -- Regression: vaults table on live DBs has TEXT-affinity timestamps
             CREATE TABLE vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                kind TEXT NOT NULL, name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE outbox (table_name TEXT NOT NULL, record_id TEXT NOT NULL, queued_at INTEGER NOT NULL);",
        )
        .unwrap();
        migrate_add_columns(&conn).unwrap();
        migrate_sync_schema(&conn).unwrap();
        let db = LocalDb {
            conn: Mutex::new(conn),
        };

        let vault = SyncRow {
            id: "v1".into(),
            revision: 0,
            vault_id: String::new(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        let saved = upsert_test_vault(&db, &vault);
        assert!(!saved.created_at.is_empty());

        let rows = list_sync_rows(&db, Table::Vaults, "", false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "v1");
        assert_eq!(rows[0].created_at, saved.created_at);
        assert_eq!(rows[0].updated_at, saved.updated_at);

        let got = get_sync_row(&db, Table::Vaults, "v1").unwrap();
        assert_eq!(got.map(|r| r.name), Some(Some("Personal".to_string())));
    }

    #[test]
    fn test_list_vaults_roundtrip() {
        let db = test_db();
        for (id, kind, name) in [("v1", "personal", "Personal"), ("v2", "team", "Team")] {
            let vault = SyncRow {
                id: id.into(),
                revision: 0,
                vault_id: String::new(),
                created_at: "0".into(),
                updated_at: "0".into(),
                deleted_at: None,
                edited_at: String::new(),
                device_id: String::new(),
                operation_id: String::new(),
                host_id: None,
                mode: None,
                name: Some(name.into()),
                owner_id: Some("u1".into()),
                kind: Some(kind.into()),
                sort_order: 0,
                ..Default::default()
            };
            upsert_test_vault(&db, &vault);
        }

        // no vault_id filter for vaults: both rows come back
        let rows = list_sync_rows(&db, Table::Vaults, "", false).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|r| r.id == "v1" && r.kind.as_deref() == Some("personal")));
        assert!(rows
            .iter()
            .any(|r| r.id == "v2" && r.kind.as_deref() == Some("team")));

        // generic db_list path also serves vaults
        let rows = list_sync_rows(&db, Table::Vaults, "whatever", false).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_delete_vault_tombstones_row() {
        let db = test_db();
        let vault = SyncRow {
            id: "v1".into(),
            revision: 0,
            vault_id: String::new(),
            created_at: "0".into(),
            updated_at: "0".into(),
            deleted_at: None,
            edited_at: String::new(),
            device_id: String::new(),
            operation_id: String::new(),
            host_id: None,
            mode: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        upsert_test_vault(&db, &vault);
        tombstone_sync_row(&db, Table::Vaults, "v1").unwrap();

        assert!(list_sync_rows(&db, Table::Vaults, "", false)
            .unwrap()
            .is_empty());
        // tombstone remains visible with include_deleted
        let all = list_sync_rows(&db, Table::Vaults, "", true).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted_at.is_some());
        // tombstone queued for sync like any delete
        let outbox = outbox_pending(&db).unwrap();
        assert!(outbox
            .iter()
            .any(|o| o.table_name == "vaults" && o.record_id == "v1"));
    }
}
