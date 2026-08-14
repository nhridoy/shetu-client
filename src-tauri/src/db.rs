use rusqlite::{params, Connection};
use std::sync::Mutex;

pub const DB_FILE_NAME: &str = "termvault.db";

/// Reset the local database contents to pristine state. Row-deletion is used
/// instead of file removal because the managed connection holds the DB file
/// open (Windows cannot delete an open file). Does not VACUUM — file size is
/// retained, data is gone.
pub fn wipe_all(db: &LocalDb) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for table in [
        "user_profiles", "user_keys", "vaults", "groups", "hosts", "keys",
        "snippets", "workspaces", "presets", "outbox", "sync_conflicts", "__sync_meta",
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
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

        CREATE TABLE IF NOT EXISTS keys (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_vault ON workspaces(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS presets (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_presets_vault ON presets(vault_id, sort_order);

        CREATE TABLE IF NOT EXISTS outbox (
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            queued_at INTEGER NOT NULL,
            PRIMARY KEY (table_name, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_queued_at ON outbox(queued_at);

        CREATE TABLE IF NOT EXISTS sync_conflicts (
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            remote_rev INTEGER NOT NULL,
            remote_payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (table_name, record_id)
        );

        CREATE TABLE IF NOT EXISTS __sync_meta (
            vault_id TEXT PRIMARY KEY,
            watermark INTEGER NOT NULL DEFAULT 0,
            last_sync_at INTEGER,
            last_device_id TEXT
);
        ",
    )
    .map_err(|e| format!("Failed to create tables: {e}"))?;
    migrate_add_columns(&conn)?;
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub email: String,
    pub name: String,
    pub auth_provider: String,
    pub provider_sub: Option<String>,
    pub salt_cl: Option<String>,
    pub kdf_m: i64,
    pub kdf_t: i64,
    pub kdf_p: i64,
    pub public_key: Option<String>,
    pub initialized: bool,
    pub last_login_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn upsert_user_profile(db: &LocalDb, profile: &UserProfile) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO user_profiles (id, email, name, auth_provider, provider_sub, salt_cl,
         kdf_m, kdf_t, kdf_p, public_key, initialized, last_login_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
            email=excluded.email, name=excluded.name, auth_provider=excluded.auth_provider,
            provider_sub=excluded.provider_sub, salt_cl=excluded.salt_cl,
            kdf_m=excluded.kdf_m, kdf_t=excluded.kdf_t, kdf_p=excluded.kdf_p,
            public_key=excluded.public_key, initialized=excluded.initialized,
            last_login_at=excluded.last_login_at, updated_at=excluded.updated_at",
        params![
            profile.id,
            profile.email,
            profile.name,
            profile.auth_provider,
            profile.provider_sub,
            profile.salt_cl,
            profile.kdf_m,
            profile.kdf_t,
            profile.kdf_p,
            profile.public_key,
            profile.initialized as i64,
            profile.last_login_at,
            profile.created_at,
            profile.updated_at,
        ],
    )
    .map_err(|e| format!("upsert_user_profile: {e}"))?;
    Ok(())
}

pub fn get_user_profile(db: &LocalDb, user_id: &str) -> Result<Option<UserProfile>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, email, name, auth_provider, provider_sub, salt_cl,
                    kdf_m, kdf_t, kdf_p, public_key, initialized, last_login_at,
                    created_at, updated_at
             FROM user_profiles WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let row = stmt
        .query_row(params![user_id], |row| {
            Ok(UserProfile {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                auth_provider: row.get(3)?,
                provider_sub: row.get(4)?,
                salt_cl: row.get(5)?,
                kdf_m: row.get(6)?,
                kdf_t: row.get(7)?,
                kdf_p: row.get(8)?,
                public_key: row.get(9)?,
                initialized: row.get::<_, i64>(10)? != 0,
                last_login_at: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })
        .ok();

    Ok(row)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserKeyRow {
    pub id: i64,
    pub user_id: String,
    pub key_type: String,
    pub payload: String,
    pub created_at: String,
}

pub fn upsert_keyring(
    db: &LocalDb,
    user_id: &str,
    key_type: &str,
    payload: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono_utc_now();
    conn.execute(
        "INSERT INTO user_keys (user_id, key_type, payload, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, key_type) DO UPDATE SET payload=excluded.payload",
        params![user_id, key_type, payload, now],
    )
    .map_err(|e| format!("upsert_keyring: {e}"))?;
    Ok(())
}

pub fn get_keyring(db: &LocalDb, user_id: &str) -> Result<Vec<UserKeyRow>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, user_id, key_type, payload, created_at
             FROM user_keys WHERE user_id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![user_id], |row| {
            Ok(UserKeyRow {
                id: row.get(0)?,
                user_id: row.get(1)?,
                key_type: row.get(2)?,
                payload: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Vaults are sync rows like any other table (per-user instead of per-vault:
/// `vault_id` is empty and `db_list` skips the vault filter for them). The
/// envelope revision/outbox/tombstone machinery applies unchanged.
pub fn upsert_vault(db: &LocalDb, vault: &SyncRow) -> Result<SyncRow, String> {
    let mut row = vault.clone();
    row.vault_id = String::new();
    row.deleted_at = None;
    upsert_sync_row(db, Table::Vaults, &row)
}

pub fn list_vaults(db: &LocalDb, include_deleted: bool) -> Result<Vec<SyncRow>, String> {
    list_sync_rows(db, Table::Vaults, "", include_deleted)
}

pub fn delete_vault(db: &LocalDb, id: &str) -> Result<(), String> {
    tombstone_sync_row(db, Table::Vaults, id)
}

fn chrono_utc_now() -> String {
    // Avoid chrono dependency — use a simple ISO-8601 timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

const ENVELOPE_COLS: &str = "id, revision, vault_id, created_at, updated_at, deleted_at";

// SELECT-side variant: CAST timestamps to INTEGER so rows written by previous
// schemas (TEXT-affinity created_at/updated_at on migrated vaults) still read
// correctly. GET is not applied on the INSERT side — casting there is invalid.
const ENVELOPE_COLS_SELECT: &str = "id, revision, vault_id, CAST(created_at AS INTEGER), CAST(updated_at AS INTEGER), CAST(deleted_at AS INTEGER)";

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
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_vals(row: &SyncRow, cols: &str) -> Vec<rusqlite::types::Value> {
    let mut v = vec![
        row.id.clone().into(),
        row.revision.into(),
        row.vault_id.clone().into(),
        row.created_at.into(),
        row.updated_at.into(),
        row.deleted_at.into(),
    ];
    let add = |v: &mut Vec<rusqlite::types::Value>, val: Option<&String>| {
        v.push(val.map(|s| s.clone().into()).unwrap_or(rusqlite::types::Value::Null));
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
        name: opt("name"),
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
        sort_order: row.get::<_, Option<i64>>("sort_order").ok().flatten().unwrap_or(0),
        is_default: row.get::<_, Option<i64>>("is_default").ok().flatten().unwrap_or(0),
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
        }
    }
}

pub fn upsert_sync_row(db: &LocalDb, table: Table, row: &SyncRow) -> Result<SyncRow, String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let existing = get_sync_row_unlocked(&conn, table, &row.id)?;
    let rev = match &existing {
        Some(e) => e.revision + 1,
        None => 1,
    };
    let now = now_ms();
    let mut out = row.clone();
    out.revision = rev;
    if let Some(e) = &existing {
        out.created_at = e.created_at;
    } else {
        out.created_at = now;
    }
    out.updated_at = now;
    out.deleted_at = None; // upsert of a tombstoned row resurrects it (LWW create/update wins)
    let cols = table_cols(table);
    let sql = format!(
        "INSERT OR REPLACE INTO {t} ({envelope}, {cols}) VALUES ({q})",
        t = table.as_str(),
        envelope = ENVELOPE_COLS,
        cols = cols,
        q = (1..=6 + cols.split(',').count()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", "),
    );
    let tx = conn.transaction().map_err(|e| format!("upsert_sync_row tx: {e}"))?;
    tx.execute(&sql, rusqlite::params_from_iter(row_vals(&out, cols)))
        .map_err(|e| format!("upsert_sync_row({}): {e}", table.as_str()))?;
    tx.execute(
        "INSERT OR REPLACE INTO outbox (table_name, record_id, queued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![table.as_str(), out.id, now],
    )
    .map_err(|e| format!("upsert_sync_row outbox: {e}"))?;
    tx.commit().map_err(|e| format!("upsert_sync_row commit: {e}"))?;
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutboxEntry {
    pub table_name: String,
    pub record_id: String,
    pub queued_at: i64,
}

pub fn tombstone_sync_row(db: &LocalDb, table: Table, id: &str) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let Some(existing) = get_sync_row_unlocked(&conn, table, id)? else {
        return Ok(()); // idempotent: nothing to tombstone
    };
    if existing.deleted_at.is_some() {
        return Ok(()); // already a tombstone — no revision bump
    }
    let now = now_ms();
    let sql = format!(
        "UPDATE {t} SET revision = ?1, updated_at = ?2, deleted_at = ?2 WHERE id = ?3",
        t = table.as_str(),
    );
    let tx = conn.transaction().map_err(|e| format!("tombstone_sync_row tx: {e}"))?;
    tx.execute(&sql, rusqlite::params![existing.revision + 1, now, id])
        .map_err(|e| format!("tombstone_sync_row({}): {e}", table.as_str()))?;
    tx.execute(
        "INSERT OR REPLACE INTO outbox (table_name, record_id, queued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![table.as_str(), id, now],
    )
    .map_err(|e| format!("tombstone_sync_row outbox: {e}"))?;
    tx.commit().map_err(|e| format!("tombstone_sync_row commit: {e}"))?;
    Ok(())
}

pub fn outbox_pending(db: &LocalDb) -> Result<Vec<OutboxEntry>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT table_name, record_id, queued_at FROM outbox ORDER BY queued_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(OutboxEntry { table_name: r.get(0)?, record_id: r.get(1)?, queued_at: r.get(2)? })
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
    conn.execute("DELETE FROM outbox WHERE table_name = ?1 AND record_id = ?2", rusqlite::params![table.as_str(), id])
        .map_err(|e| format!("outbox_remove: {e}"))?;
    Ok(())
}

pub fn get_sync_row(db: &LocalDb, table: Table, id: &str) -> Result<Option<SyncRow>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_sync_row_unlocked(&conn, table, id)
}

pub fn update_host_os(db: &LocalDb, host_id: &str, os: &str) -> Result<(), String> {
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| format!("update_host_os tx: {e}"))?;
    let now = now_ms();
    tx.execute(
        "UPDATE hosts SET os = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![os, now, host_id],
    )
    .map_err(|e| format!("update_host_os: {e}"))?;
    tx.execute(
        "INSERT OR REPLACE INTO outbox (table_name, record_id, queued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params!["hosts", host_id, now],
    )
    .map_err(|e| format!("update_host_os outbox: {e}"))?;
    tx.commit().map_err(|e| format!("update_host_os commit: {e}"))?;
    Ok(())
}

fn get_sync_row_unlocked(conn: &Connection, table: Table, id: &str) -> Result<Option<SyncRow>, String> {
    let cols = table_cols(table);
    let sql = format!(
        "SELECT {envelope}, {cols} FROM {t} WHERE id = ?1",
        envelope = ENVELOPE_COLS_SELECT, t = table.as_str(), cols = cols,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map(rusqlite::params![id], |r| row_from(table, r)).map_err(|e| e.to_string())?;
    Ok(rows.next().transpose().map_err(|e| e.to_string())?)
}

pub fn list_sync_rows(db: &LocalDb, table: Table, vault_id: &str, include_deleted: bool) -> Result<Vec<SyncRow>, String> {
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
        if include_deleted { "WHERE vault_id = ?1" } else { "WHERE deleted_at IS NULL AND vault_id = ?1" }
    } else if !include_deleted {
        "WHERE deleted_at IS NULL"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {envelope}, {cols} FROM {t} {where_clause} ORDER BY sort_order, created_at DESC",
        envelope = ENVELOPE_COLS_SELECT, t = table.as_str(), cols = cols, where_clause = where_clause,
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
pub enum Table { Vaults, Groups, Hosts, Keys, Snippets, Workspaces, Presets }

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct SyncRow {
    pub id: String,
    pub revision: i64,
    pub vault_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub name: Option<String>,
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

/// Batch-update sort_order for multiple rows in a single transaction.
pub fn update_sort_orders(
    db: &LocalDb,
    table: Table,
    updates: &[(String, i64)],
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let t = table.as_str();
    let now = now_ms();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    for (id, order) in updates {
        conn.execute(
            &format!("UPDATE {t} SET sort_order = ?1, updated_at = ?2 WHERE id = ?3"),
            rusqlite::params![order, now, id],
        )
        .map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK");
            format!("update_sort_orders: {e}")
        })?;
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for t in ["user_profiles", "user_keys", "vaults", "groups", "hosts", "keys",
                  "snippets", "workspaces", "presets", "outbox", "sync_conflicts", "__sync_meta"] {
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
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, os TEXT, group_id TEXT, key_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE keys (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE snippets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, description TEXT,
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
            assert!(cols.contains(&column.to_string()), "missing {table}.{column}");
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
            "INSERT INTO outbox (table_name, record_id, queued_at) VALUES ('hosts', 'h1', 1)", [],
        ).unwrap();
        drop(conn);
        wipe_all(&db).unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM hosts", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn test_upsert_group_roundtrip_and_revision_bump() {
        let db = test_db();
        let g1 = SyncRow { id: "g1".into(), revision: 99, vault_id: "v1".into(),
            created_at: 0, updated_at: 0, deleted_at: None, name: Some("Servers".into()),
            os: None, auth_type: None, tags: None, color: None, description: None,
            key_type: None, fingerprint: None, public_key: None, owner_id: None, kind: None,
            sort_order: 0, is_default: 0,
            parent_id: None, group_id: None, key_id: None, data: "{}".into() };
        let saved = upsert_sync_row(&db, Table::Groups, &g1).unwrap();
        assert_eq!(saved.revision, 1);                       // caller revision ignored
        assert_eq!(saved.vault_id, "v1");
        assert_eq!(saved.name.as_deref(), Some("Servers"));
        assert!(saved.created_at > 0 && saved.updated_at >= saved.created_at);

        let updated = upsert_sync_row(&db, Table::Groups, &g1).unwrap();
        assert_eq!(updated.revision, 2);                     // bump on update
        assert_eq!(updated.created_at, saved.created_at);    // preserved
    }

    #[test]
    fn test_upsert_host_roundtrip() {
        let db = test_db();
        let h = SyncRow { id: "h1".into(), revision: 1, vault_id: "v1".into(),
            created_at: 0, updated_at: 0, deleted_at: None, name: Some("prod".into()),
            os: Some("linux".into()), auth_type: Some("password".into()),
            tags: Some("[\"web\",\"prod\"]".into()), color: Some("#ff0000".into()),
            description: None, key_type: None, fingerprint: None, public_key: None,
            owner_id: None, kind: None, sort_order: 3, is_default: 0, parent_id: None, group_id: Some("g1".into()),
            key_id: Some("k1".into()), data: "encrypted".into() };
        upsert_sync_row(&db, Table::Hosts, &h).unwrap();
        let loaded = get_sync_row(&db, Table::Hosts, "h1").unwrap().unwrap();
        assert_eq!(loaded.name.as_deref(), Some("prod"));
        assert_eq!(loaded.group_id.as_deref(), Some("g1"));
        assert_eq!(loaded.os.as_deref(), Some("linux"));
        assert_eq!(loaded.auth_type.as_deref(), Some("password"));
        assert_eq!(loaded.tags.as_deref(), Some("[\"web\",\"prod\"]"));
        assert_eq!(loaded.color.as_deref(), Some("#ff0000"));
        assert_eq!(loaded.data, "encrypted");                // opaque passthrough
        assert_eq!(list_sync_rows(&db, Table::Hosts, "v1", false).unwrap().len(), 1);
    }

    #[test]
    fn test_list_scoped_to_vault_and_sorted() {
        let db = test_db();
        for (id, vault, order) in [("h1", "v1", 2), ("h2", "v1", 1), ("h3", "v2", 9)] {
            let h = SyncRow { id: id.into(), revision: 1, vault_id: vault.into(),
                created_at: 1, updated_at: 1, deleted_at: None, name: Some(id.into()),
                os: None, auth_type: None, tags: None, color: None, description: None,
                key_type: None, fingerprint: None, public_key: None, owner_id: None, kind: None,
                sort_order: order, is_default: 0,
                parent_id: None, group_id: None, key_id: None, data: "{}".into() };
            upsert_sync_row(&db, Table::Hosts, &h).unwrap();
        }
        let v1 = list_sync_rows(&db, Table::Hosts, "v1", false).unwrap();
        assert_eq!(v1.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["h2", "h1"]);
    }

    #[test]
    fn test_upsert_user_profile_roundtrip() {
        let db = test_db();
        let profile = UserProfile {
            id: "u1".to_string(),
            email: "test@example.com".to_string(),
            name: "Test User".to_string(),
            auth_provider: "password".to_string(),
            provider_sub: None,
            salt_cl: Some("abc123".to_string()),
            kdf_m: 67108864,
            kdf_t: 3,
            kdf_p: 1,
            public_key: Some("pk_base64".to_string()),
            initialized: true,
            last_login_at: None,
            created_at: "1700000000".to_string(),
            updated_at: "1700000000".to_string(),
        };
        upsert_user_profile(&db, &profile).unwrap();

        let loaded = get_user_profile(&db, "u1").unwrap().unwrap();
        assert_eq!(loaded.email, "test@example.com");
        assert_eq!(loaded.name, "Test User");
        assert!(loaded.initialized);
    }

    #[test]
    fn test_upsert_user_profile_updates() {
        let db = test_db();
        let mut profile = UserProfile {
            id: "u1".to_string(),
            email: "old@example.com".to_string(),
            name: "Old Name".to_string(),
            auth_provider: "password".to_string(),
            provider_sub: None,
            salt_cl: None,
            kdf_m: 67108864,
            kdf_t: 3,
            kdf_p: 1,
            public_key: None,
            initialized: false,
            last_login_at: None,
            created_at: "1700000000".to_string(),
            updated_at: "1700000000".to_string(),
        };
        upsert_user_profile(&db, &profile).unwrap();

        profile.email = "new@example.com".to_string();
        profile.name = "New Name".to_string();
        profile.initialized = true;
        upsert_user_profile(&db, &profile).unwrap();

        let loaded = get_user_profile(&db, "u1").unwrap().unwrap();
        assert_eq!(loaded.email, "new@example.com");
        assert_eq!(loaded.name, "New Name");
        assert!(loaded.initialized);
    }

    #[test]
    fn test_upsert_keyring_roundtrip() {
        let db = test_db();
        upsert_keyring(&db, "u1", "dek_wrapped_by_kek", "encrypted_payload_1").unwrap();
        upsert_keyring(&db, "u1", "dek_wrapped_by_recovery", "encrypted_payload_2").unwrap();

        let keys = get_keyring(&db, "u1").unwrap();
        assert_eq!(keys.len(), 2);

        let dek_key = keys.iter().find(|k| k.key_type == "dek_wrapped_by_kek").unwrap();
        assert_eq!(dek_key.payload, "encrypted_payload_1");
    }

    #[test]
    fn test_upsert_keyring_updates() {
        let db = test_db();
        upsert_keyring(&db, "u1", "dek_wrapped_by_kek", "old_payload").unwrap();
        upsert_keyring(&db, "u1", "dek_wrapped_by_kek", "new_payload").unwrap();

        let keys = get_keyring(&db, "u1").unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].payload, "new_payload");
    }

    #[test]
    fn test_tombstone_hides_row_and_bumps_outbox() {
        let db = test_db();
        let k = SyncRow { id: "k1".into(), revision: 1, vault_id: "v1".into(), created_at: 1,
            updated_at: 1, deleted_at: None, name: Some("key".into()), os: None,
            auth_type: None, tags: None, color: None, description: None,
            key_type: Some("ed25519".into()), fingerprint: Some("SHA256:abc".into()),
            public_key: Some("ssh-ed25519 AAAA".into()), owner_id: None, kind: None,
            sort_order: 0, is_default: 0,
            parent_id: None, group_id: None, key_id: None, data: "enc".into() };
        upsert_sync_row(&db, Table::Keys, &k).unwrap();
        let loaded = get_sync_row(&db, Table::Keys, "k1").unwrap().unwrap();
        assert_eq!(loaded.key_type.as_deref(), Some("ed25519"));
        assert_eq!(loaded.fingerprint.as_deref(), Some("SHA256:abc"));
        assert_eq!(loaded.public_key.as_deref(), Some("ssh-ed25519 AAAA"));
        assert_eq!(list_sync_rows(&db, Table::Keys, "v1", false).unwrap().len(), 1);

        tombstone_sync_row(&db, Table::Keys, "k1").unwrap();
        let all = list_sync_rows(&db, Table::Keys, "v1", true).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted_at.is_some() && all[0].revision == 2);
        assert_eq!(list_sync_rows(&db, Table::Keys, "v1", false).unwrap().len(), 0);

        // idempotent: second tombstone does not bump again
        tombstone_sync_row(&db, Table::Keys, "k1").unwrap();
        let all2 = list_sync_rows(&db, Table::Keys, "v1", true).unwrap();
        assert_eq!(all2[0].revision, 2);

        let pending = outbox_pending(&db).unwrap();
        assert!(pending.iter().any(|o| o.table_name == "keys" && o.record_id == "k1"));
    }

    #[test]
    fn test_outbox_remove_and_remaining_tables_roundtrip() {
        let db = test_db();
        for (table, id) in [(Table::Snippets, "s1"), (Table::Workspaces, "w1"), (Table::Presets, "p1")] {
            let row = SyncRow { id: id.into(), revision: 1, vault_id: "v1".into(), created_at: 1,
                updated_at: 1, deleted_at: None, name: Some("n".into()), os: None,
                auth_type: None, tags: Some("[\"t1\"]".into()), color: None, description: None,
                key_type: None, fingerprint: None, public_key: None, owner_id: None, kind: None,
                sort_order: 0, is_default: 0,
                parent_id: None, group_id: None, key_id: None, data: "enc".into() };
            upsert_sync_row(&db, table, &row).unwrap();
        }
        let s1 = get_sync_row(&db, Table::Snippets, "s1").unwrap().unwrap();
        assert_eq!(s1.tags.as_deref(), Some("[\"t1\"]"));
        assert_eq!(list_sync_rows(&db, Table::Snippets, "v1", false).unwrap().len(), 1);
        assert_eq!(list_sync_rows(&db, Table::Workspaces, "v1", false).unwrap().len(), 1);
        assert_eq!(list_sync_rows(&db, Table::Presets, "v1", false).unwrap().len(), 1);
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
        })).unwrap();
        assert_eq!(host.revision, 0);
        assert_eq!(host.created_at, 0);
        assert_eq!(host.updated_at, 0);
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
        })).unwrap();
        assert_eq!(key.revision, 0);
        assert_eq!(key.description.as_deref(), Some("main"));
        assert_eq!(key.key_type.as_deref(), Some("rsa"));
        assert_eq!(key.fingerprint.as_deref(), Some("SHA256:x"));
        assert_eq!(key.public_key.as_deref(), Some("ssh-rsa AAAA"));
        assert!(key.group_id.is_none() && key.key_id.is_none());

        let snippet = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "s1", "vault_id": "v1", "name": "script",
            "description": "d", "sort_order": 0, "data": "enc"
        })).unwrap();
        assert_eq!(snippet.revision, 0);
        assert_eq!(snippet.name.as_deref(), Some("script"));

        let workspace = serde_json::from_value::<SyncRow>(serde_json::json!({
            "id": "w1", "vault_id": "v1", "name": "prod", "sort_order": 0, "data": "enc"
        })).unwrap();
        assert_eq!(workspace.revision, 0);
        assert_eq!(workspace.updated_at, 0);
        assert!(workspace.deleted_at.is_none());
        assert_eq!(workspace.data, "enc");
    }

    #[test]
    fn test_upsert_vault_roundtrip() {
        let db = test_db();
        let vault = SyncRow {
            id: "v1".into(),
            revision: 0,
            vault_id: String::new(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        let saved = upsert_vault(&db, &vault).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.name.as_deref(), Some("Personal"));
        assert_eq!(saved.owner_id.as_deref(), Some("u1"));

        // user-created vaults are never the default (the server-seeded one is)
        assert_eq!(saved.is_default, 0);

        let (revision, deleted_at): (i64, Option<i64>) = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT revision, deleted_at FROM vaults WHERE id = 'v1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(revision, 1);
        assert!(deleted_at.is_none());

        // vault writes hit the outbox like any sync row
        let outbox = outbox_pending(&db).unwrap();
        assert!(outbox.iter().any(|o| o.table_name == "vaults" && o.record_id == "v1"));
    }

    #[test]
    fn test_vaults_readable_on_migrated_text_schema() {
        // Regression: live DBs created before the vault sync-envelope migration have
        // TEXT-affinity created_at/updated_at. New writes store epoch-ms as TEXT, so
        // list/get must CAST (a plain i64 read raises InvalidColumnType → empty lists).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE hosts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, os TEXT, group_id TEXT, key_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE keys (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE snippets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
                vault_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                deleted_at INTEGER, name TEXT NOT NULL, description TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
             -- Regression: vaults table on live DBs has TEXT-affinity timestamps
             CREATE TABLE vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                kind TEXT NOT NULL, name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE outbox (table_name TEXT NOT NULL, record_id TEXT NOT NULL, queued_at INTEGER NOT NULL);",
        )
        .unwrap();
        migrate_add_columns(&conn).unwrap();
        let db = LocalDb { conn: Mutex::new(conn) };

        let vault = SyncRow {
            id: "v1".into(),
            revision: 0,
            vault_id: String::new(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        let saved = upsert_vault(&db, &vault).unwrap();
        assert!(saved.created_at > 0);

        let rows = list_vaults(&db, false).unwrap();
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
                created_at: 0,
                updated_at: 0,
                deleted_at: None,
                name: Some(name.into()),
                owner_id: Some("u1".into()),
                kind: Some(kind.into()),
                sort_order: 0,
                ..Default::default()
            };
            upsert_vault(&db, &vault).unwrap();
        }

        // no vault_id filter for vaults: both rows come back
        let rows = list_vaults(&db, false).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.id == "v1" && r.kind.as_deref() == Some("personal")));
        assert!(rows.iter().any(|r| r.id == "v2" && r.kind.as_deref() == Some("team")));

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
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            name: Some("Personal".into()),
            owner_id: Some("u1".into()),
            kind: Some("personal".into()),
            sort_order: 0,
            ..Default::default()
        };
        upsert_vault(&db, &vault).unwrap();
        delete_vault(&db, "v1").unwrap();

        assert!(list_vaults(&db, false).unwrap().is_empty());
        // tombstone remains visible with include_deleted
        let all = list_vaults(&db, true).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted_at.is_some());
        // tombstone queued for sync like any delete
        let outbox = outbox_pending(&db).unwrap();
        assert!(outbox.iter().any(|o| o.table_name == "vaults" && o.record_id == "v1"));
    }
}
