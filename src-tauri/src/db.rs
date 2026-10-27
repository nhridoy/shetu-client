use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{Connection, Transaction};
use std::sync::Mutex;

#[path = "sync_db.rs"]
pub mod sync_db;

pub const DB_FILE_NAME: &str = "terra.db";

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
        "team_vault_keys",
        "team_vaults",
        "team_outbox",
        "team_sync_state",
        "team_invites",
        "team_members",
        "team_records",
        "vaults",
        "groups",
        "hosts",
        "keys",
        "snippets",
        "workspaces",
        "presets",
        "session_history",
        "session_output_chunks",
        "session_preferences",
        "outbox",
        "sync_conflicts",
        "sync_snapshot_seen",
        "sync_snapshot_state",
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRecord {
    pub account_id: String,
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub sync_status: String,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamOutboxOperation {
    pub account_id: String,
    pub operation_id: String,
    pub operation_type: String,
    pub payload: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberRecord {
    pub account_id: String,
    pub team_id: String,
    pub id: String,
    pub user_id: String,
    pub email: String,
    pub full_name: String,
    pub role: String,
    pub created_at: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInviteRecord {
    pub account_id: String,
    pub id: String,
    pub team_id: String,
    pub email: String,
    pub role: String,
    pub status: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultRecord {
    pub account_id: String,
    pub team_id: String,
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub key_epoch: u32,
    pub rotation_state: String,
    pub revision: u32,
    pub created_at: String,
}

/// Apply one server snapshot page, its key envelopes, revocations, and cursor
/// as a single SQLite transaction. A cursor can therefore never move past a
/// page whose local changes failed to commit.
pub fn apply_team_sync_page(
    db: &LocalDb,
    account_id: &str,
    snapshot: &crate::team_sync::TeamSnapshot,
    envelopes: &[crate::team_sync::KeyEnvelopeWire],
    session: &crate::crypto::KeySession,
    cursor: Option<&str>,
    persist_cursor: bool,
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for team in &snapshot.teams {
        uuid::Uuid::parse_str(&team.id).map_err(|_| "invalid team ID")?;
        uuid::Uuid::parse_str(&team.owner_id).map_err(|_| "invalid team owner ID")?;
        if team.name.trim().is_empty() {
            return Err("team name cannot be empty".into());
        }
        tx.execute(
            "INSERT INTO team_records (account_id,id,owner_id,name,created_at,updated_at,sync_status,sync_error) VALUES (?1,?2,?3,?4,?5,?6,'synced',NULL)
             ON CONFLICT(account_id,id) DO UPDATE SET owner_id=excluded.owner_id,name=excluded.name,updated_at=excluded.updated_at,sync_status='synced',sync_error=NULL",
            rusqlite::params![account_id, team.id, team.owner_id, team.name.trim(), team.created_at, team.updated_at],
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM team_members WHERE account_id=?1 AND team_id=?2",
            rusqlite::params![account_id, team.id],
        )
        .map_err(|e| e.to_string())?;
        for member in snapshot
            .members
            .iter()
            .filter(|member| member.team_id == team.id)
        {
            for id in [&member.id, &member.user_id] {
                uuid::Uuid::parse_str(id).map_err(|_| "invalid team member ID")?;
            }
            tx.execute(
                "INSERT INTO team_members (account_id,team_id,id,user_id,email,full_name,role,created_at,public_key,fingerprint) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                rusqlite::params![account_id, member.team_id, member.id, member.user_id, member.email, member.full_name, member.role, member.created_at, member.public_key, member.fingerprint],
            ).map_err(|e| e.to_string())?;
        }
    }

    let mut pending_responses = std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT operation_type,payload FROM team_outbox WHERE account_id=?1 AND status='pending' AND operation_type IN ('invite.accept','invite.decline')")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (operation_type, payload) = row.map_err(|e| e.to_string())?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
                continue;
            };
            if let Some(invite_id) = value.get("invite_id").and_then(serde_json::Value::as_str) {
                pending_responses.insert(
                    invite_id.to_owned(),
                    if operation_type == "invite.accept" {
                        "accept_pending"
                    } else {
                        "decline_pending"
                    },
                );
            }
        }
    }
    tx.execute("DELETE FROM team_invites WHERE account_id=?1", [account_id])
        .map_err(|e| e.to_string())?;
    for invite in &snapshot.invites {
        for id in [&invite.id, &invite.team_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "invalid invite ID")?;
        }
        let status = pending_responses
            .get(&invite.id)
            .copied()
            .unwrap_or(&invite.state);
        tx.execute(
            "INSERT INTO team_invites (account_id,id,team_id,email,role,status,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![account_id, invite.id, invite.team_id, invite.recipient_email, invite.role, status, invite.created_at, invite.expires_at],
        ).map_err(|e| e.to_string())?;
    }

    for vault in &snapshot.vaults {
        import_team_vault_metadata_in_transaction(
            &tx,
            &vault.id,
            &vault.team_id,
            &vault.owner_id,
            &vault.name,
            vault.key_epoch,
            &vault.rotation_state,
        )?;
        if vault.revision == 0 {
            return Err("invalid team vault revision".into());
        }
        tx.execute(
            "UPDATE vaults SET revision=?1 WHERE id=?2 AND kind='team'",
            rusqlite::params![vault.revision, vault.id],
        )
        .map_err(|e| e.to_string())?;
    }

    for envelope in envelopes {
        let grant = crate::team_keys::TeamKeyEnvelope {
            version: envelope.version,
            context: crate::team_keys::GrantContext {
                team_id: envelope.team_id.clone(),
                vault_id: envelope.vault_id.clone(),
                epoch: envelope.epoch,
                recipient_user_id: envelope.recipient_user_id.clone(),
                recipient_fingerprint: envelope.recipient_fingerprint.clone(),
            },
            ephemeral_public_key: envelope.ephemeral_public_key.clone(),
            nonce: envelope.nonce.clone(),
            ciphertext: envelope.ciphertext.clone(),
        };
        crate::team_keys::import_team_grant_in_transaction(&tx, session, account_id, &grant)?;
    }

    for team_id in &snapshot.revoked_team_ids {
        uuid::Uuid::parse_str(team_id).map_err(|_| "invalid revoked team ID")?;
        tx.execute(
            "UPDATE team_vaults SET rotation_state='revoked' WHERE team_id=?1",
            [team_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM team_members WHERE account_id=?1 AND team_id=?2",
            rusqlite::params![account_id, team_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM team_invites WHERE account_id=?1 AND team_id=?2",
            rusqlite::params![account_id, team_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM team_records WHERE account_id=?1 AND id=?2",
            rusqlite::params![account_id, team_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for vault_id in &snapshot.deleted_vault_ids {
        uuid::Uuid::parse_str(vault_id).map_err(|_| "invalid deleted vault ID")?;
        tx.execute(
            "UPDATE team_vaults SET rotation_state='revoked' WHERE vault_id=?1 AND EXISTS (SELECT 1 FROM team_records tr WHERE tr.id=team_vaults.team_id AND tr.account_id=?2)",
            rusqlite::params![vault_id, account_id],
        )
        .map_err(|e| e.to_string())?;
        let now = now_iso();
        tx.execute(
            "UPDATE vaults SET deleted_at=COALESCE(deleted_at,?1),updated_at=?1 WHERE id=?2 AND kind='team'",
            rusqlite::params![now, vault_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if persist_cursor {
        tx.execute(
            "INSERT INTO team_sync_state (account_id,cursor,updated_at) VALUES (?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
            rusqlite::params![account_id, cursor, now_iso()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn import_team_vault_metadata_in_transaction(
    tx: &Transaction<'_>,
    vault_id: &str,
    team_id: &str,
    owner_id: &str,
    name: &str,
    epoch: u32,
    rotation_state: &str,
) -> Result<(), String> {
    for id in [vault_id, team_id, owner_id] {
        uuid::Uuid::parse_str(id).map_err(|_| "invalid team vault metadata ID")?;
    }
    if name.trim().is_empty() || epoch == 0 || rotation_state.is_empty() {
        return Err("invalid team vault metadata".into());
    }
    use rusqlite::OptionalExtension;
    let existing: Option<(String, u32, String)> = tx
        .query_row(
            "SELECT team_id, epoch, rotation_state FROM team_vaults WHERE vault_id=?1",
            [vault_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let row_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vaults WHERE id=?1)",
            [vault_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if existing.is_none() && row_exists {
        return Err("cannot convert existing private vault into team vault".into());
    }
    if let Some((stored_team, stored_epoch, stored_state)) = existing {
        if stored_team != team_id || epoch < stored_epoch {
            return Err("team vault identity or epoch rollback".into());
        }
        if stored_state == "revoked" && epoch == stored_epoch && rotation_state != "revoked" {
            return Err("revoked team vault requires a newer key epoch".into());
        }
    }
    tx.execute(
        "INSERT INTO team_vaults (vault_id,team_id,epoch,rotation_state) VALUES (?1,?2,?3,?4) ON CONFLICT(vault_id) DO UPDATE SET epoch=excluded.epoch,rotation_state=excluded.rotation_state",
        rusqlite::params![vault_id, team_id, epoch, rotation_state],
    )
    .map_err(|e| e.to_string())?;
    let now = now_iso();
    tx.execute(
        "INSERT INTO vaults (id,revision,vault_id,created_at,updated_at,owner_id,kind,name,data) VALUES (?1,1,'',?2,?2,?3,'team',?4,'{}') ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,deleted_at=NULL",
        rusqlite::params![vault_id, now, owner_id, name.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn import_legacy_team_cache(
    db: &LocalDb,
    account_id: &str,
    teams: &serde_json::Value,
    vaults: &serde_json::Value,
) -> Result<bool, String> {
    fn field<'a>(
        value: &'a serde_json::Value,
        camel: &str,
        snake: &str,
    ) -> Option<&'a str> {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(serde_json::Value::as_str)
    }
    use rusqlite::OptionalExtension;
    validate_team_account_id(account_id)?;
    let teams = teams
        .as_array()
        .ok_or("legacy teams cache must be an array")?;
    let vaults = vaults
        .as_array()
        .ok_or("legacy vault cache must be an array")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let imported: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM team_cache_migrations WHERE account_id=?1)",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if imported {
        return Ok(false);
    }
    for team in teams {
        let (Some(id), Some(name)) = (field(team, "id", "id"), field(team, "name", "name")) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() || name.trim().is_empty() {
            continue;
        }
        let owner = field(team, "ownerId", "owner_id").unwrap_or(account_id);
        if uuid::Uuid::parse_str(owner).is_err() {
            continue;
        }
        let created = field(team, "createdAt", "created_at").unwrap_or_else(|| "");
        let updated = field(team, "updatedAt", "updated_at").unwrap_or(created);
        tx.execute("INSERT INTO team_records (account_id,id,owner_id,name,created_at,updated_at,sync_status) VALUES (?1,?2,?3,?4,?5,?6,'pending') ON CONFLICT(account_id,id) DO NOTHING", rusqlite::params![account_id,id,owner,name.trim(),created,updated]).map_err(|e| e.to_string())?;
        if let Some(members) = team.get("members").and_then(serde_json::Value::as_array) {
            for member in members {
                let Some(user_id) = field(member, "userId", "user_id") else {
                    continue;
                };
                if uuid::Uuid::parse_str(user_id).is_err() {
                    continue;
                }
                let member_id = field(member, "id", "id").unwrap_or(user_id);
                if uuid::Uuid::parse_str(member_id).is_err() {
                    continue;
                }
                let email = field(member, "email", "email").unwrap_or("");
                let full_name = field(member, "username", "full_name")
                    .or_else(|| field(member, "fullName", "full_name"))
                    .unwrap_or("");
                let role = field(member, "role", "role").unwrap_or("member");
                let joined = field(member, "joinedAt", "created_at")
                    .or_else(|| field(member, "createdAt", "created_at"))
                    .unwrap_or(created);
                let public_key = field(member, "publicKey", "public_key").unwrap_or("");
                let fingerprint = field(member, "fingerprint", "fingerprint").unwrap_or("");
                tx.execute("INSERT INTO team_members (account_id,team_id,id,user_id,email,full_name,role,created_at,public_key,fingerprint) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(account_id,team_id,user_id) DO NOTHING", rusqlite::params![account_id,id,member_id,user_id,email,full_name,role,joined,public_key,fingerprint]).map_err(|e| e.to_string())?;
            }
        }
    }
    for vault in vaults {
        let (Some(id), Some(team_id), Some(name)) = (
            field(vault, "id", "id"),
            field(vault, "teamId", "team_id"),
            field(vault, "name", "name"),
        ) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err()
            || uuid::Uuid::parse_str(team_id).is_err()
            || name.trim().is_empty()
        {
            continue;
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT owner_id FROM team_records WHERE account_id=?1 AND id=?2",
                rusqlite::params![account_id, team_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(owner) = owner else {
            continue;
        };
        let created = field(vault, "createdAt", "created_at").unwrap_or_else(|| "");
        tx.execute("INSERT INTO team_vaults (vault_id,team_id,epoch,rotation_state) VALUES (?1,?2,1,'ready') ON CONFLICT(vault_id) DO NOTHING", rusqlite::params![id,team_id]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO vaults (id,revision,vault_id,created_at,updated_at,owner_id,kind,name,data) VALUES (?1,1,'',?2,?2,?3,'team',?4,'{}') ON CONFLICT(id) DO NOTHING", rusqlite::params![id,created,owner,name.trim()]).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO team_cache_migrations (account_id,imported_at) VALUES (?1,?2)",
        rusqlite::params![account_id, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn team_cache_imported(db: &LocalDb, account_id: &str) -> Result<bool, String> {
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM team_cache_migrations WHERE account_id=?1)",
        [account_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn validate_team_account_id(account_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(account_id)
        .map(|_| ())
        .map_err(|_| "invalid account ID".into())
}

pub fn upsert_team(db: &LocalDb, team: &TeamRecord) -> Result<(), String> {
    validate_team_account_id(&team.account_id)?;
    uuid::Uuid::parse_str(&team.id).map_err(|_| "invalid team ID")?;
    if team.name.trim().is_empty() {
        return Err("team name cannot be empty".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO team_records (account_id,id,owner_id,name,created_at,updated_at,sync_status,sync_error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(account_id,id) DO UPDATE SET owner_id=excluded.owner_id,name=excluded.name,updated_at=excluded.updated_at,sync_status=excluded.sync_status,sync_error=excluded.sync_error",
        rusqlite::params![team.account_id, team.id, team.owner_id, team.name.trim(), team.created_at, team.updated_at, team.sync_status, team.sync_error],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_teams(db: &LocalDb, account_id: &str) -> Result<Vec<TeamRecord>, String> {
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT account_id,id,owner_id,name,created_at,updated_at,sync_status,sync_error FROM team_records WHERE account_id=?1 ORDER BY name COLLATE NOCASE,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], |row| {
            Ok(TeamRecord {
                account_id: row.get(0)?,
                id: row.get(1)?,
                owner_id: row.get(2)?,
                name: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                sync_status: row.get(6)?,
                sync_error: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn replace_team_members(
    db: &LocalDb,
    account_id: &str,
    team_id: &str,
    members: &[TeamMemberRecord],
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM team_members WHERE account_id=?1 AND team_id=?2",
        rusqlite::params![account_id, team_id],
    )
    .map_err(|e| e.to_string())?;
    for member in members {
        if member.account_id != account_id || member.team_id != team_id {
            return Err("team member scope mismatch".into());
        }
        uuid::Uuid::parse_str(&member.user_id).map_err(|_| "invalid member ID")?;
        uuid::Uuid::parse_str(&member.id).map_err(|_| "invalid team membership ID")?;
        tx.execute("INSERT INTO team_members (account_id,team_id,id,user_id,email,full_name,role,created_at,public_key,fingerprint) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![member.account_id, member.team_id, member.id, member.user_id, member.email, member.full_name, member.role, member.created_at, member.public_key, member.fingerprint]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn list_team_members(
    db: &LocalDb,
    account_id: &str,
    team_id: &str,
) -> Result<Vec<TeamMemberRecord>, String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT account_id,team_id,id,user_id,email,full_name,role,created_at,public_key,fingerprint FROM team_members WHERE account_id=?1 AND team_id=?2 ORDER BY email COLLATE NOCASE,user_id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![account_id, team_id], |r| {
            Ok(TeamMemberRecord {
                account_id: r.get(0)?,
                team_id: r.get(1)?,
                id: r.get(2)?,
                user_id: r.get(3)?,
                email: r.get(4)?,
                full_name: r.get(5)?,
                role: r.get(6)?,
                created_at: r.get(7)?,
                public_key: r.get(8)?,
                fingerprint: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn replace_team_invites(
    db: &LocalDb,
    account_id: &str,
    invites: &[TeamInviteRecord],
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut pending_responses = std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT operation_type,payload FROM team_outbox WHERE account_id=?1 AND status='pending' AND operation_type IN ('invite.accept','invite.decline')")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (operation_type, payload) = row.map_err(|e| e.to_string())?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
                continue;
            };
            if let Some(invite_id) = value.get("invite_id").and_then(serde_json::Value::as_str) {
                pending_responses.insert(
                    invite_id.to_owned(),
                    if operation_type == "invite.accept" {
                        "accept_pending"
                    } else {
                        "decline_pending"
                    },
                );
            }
        }
    }
    tx.execute("DELETE FROM team_invites WHERE account_id=?1", [account_id])
        .map_err(|e| e.to_string())?;
    for invite in invites {
        if invite.account_id != account_id {
            return Err("team invite scope mismatch".into());
        }
        for id in [&invite.id, &invite.team_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "invalid invite ID")?;
        }
        let status = pending_responses
            .get(&invite.id)
            .copied()
            .unwrap_or(&invite.status);
        tx.execute("INSERT INTO team_invites (account_id,id,team_id,email,role,status,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![invite.account_id,invite.id,invite.team_id,invite.email,invite.role,status,invite.created_at,invite.expires_at]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn list_team_invites(db: &LocalDb, account_id: &str) -> Result<Vec<TeamInviteRecord>, String> {
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT account_id,id,team_id,email,role,status,created_at,expires_at FROM team_invites WHERE account_id=?1 ORDER BY created_at DESC,id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], |r| {
            Ok(TeamInviteRecord {
                account_id: r.get(0)?,
                id: r.get(1)?,
                team_id: r.get(2)?,
                email: r.get(3)?,
                role: r.get(4)?,
                status: r.get(5)?,
                created_at: r.get(6)?,
                expires_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn list_team_vaults(
    db: &LocalDb,
    account_id: &str,
    team_id: &str,
) -> Result<Vec<TeamVaultRecord>, String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT ?1,t.team_id,v.id,v.name,v.owner_id,t.epoch,t.rotation_state,v.revision,v.created_at FROM team_vaults t JOIN vaults v ON v.id=t.vault_id JOIN team_records tr ON tr.id=t.team_id WHERE tr.account_id=?1 AND t.team_id=?2 AND v.deleted_at IS NULL ORDER BY v.name COLLATE NOCASE,v.id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![account_id, team_id], |r| {
            Ok(TeamVaultRecord {
                account_id: r.get(0)?,
                team_id: r.get(1)?,
                id: r.get(2)?,
                name: r.get(3)?,
                owner_id: r.get(4)?,
                key_epoch: r.get(5)?,
                rotation_state: r.get(6)?,
                revision: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn update_team_vault_revision(
    db: &LocalDb,
    vault_id: &str,
    revision: u32,
) -> Result<(), String> {
    uuid::Uuid::parse_str(vault_id).map_err(|_| "invalid team vault ID")?;
    if revision == 0 {
        return Err("invalid team vault revision".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE vaults SET revision=?1 WHERE id=?2 AND kind='team'",
        rusqlite::params![revision, vault_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn enqueue_team_operation(
    db: &LocalDb,
    account_id: &str,
    operation_type: &str,
    payload: &str,
) -> Result<String, String> {
    validate_team_account_id(account_id)?;
    const TYPES: &[&str] = &[
        "team.create",
        "team.rename",
        "team.delete",
        "vault.create",
        "vault.rename",
        "vault.delete",
        "invite.create",
        "invite.accept",
        "invite.decline",
        "member.remove",
        "member.role",
        "vault.rotate",
    ];
    if !TYPES.contains(&operation_type) {
        return Err("unsupported team operation".into());
    }
    if payload.len() > 32 * 1024 {
        return Err("team operation payload exceeds 32 KiB".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "invalid team operation JSON")?;
    if !value.is_object() {
        return Err("team operation payload must be an object".into());
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let get = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("team operation is missing {key}"))
    };
    match operation_type {
        "team.create" => {
            let id = get("team_id")?;
            uuid::Uuid::parse_str(id).map_err(|_| "invalid team ID")?;
            let name = get("name")?.trim();
            if name.is_empty() || name.len() > 120 {
                return Err("invalid team name".into());
            }
            tx.execute("INSERT INTO team_records (account_id,id,owner_id,name,created_at,updated_at,sync_status) VALUES (?1,?2,?1,?3,?4,?4,'pending')", rusqlite::params![account_id,id,name,now]).map_err(|e| e.to_string())?;
        }
        "team.rename" => {
            let id = get("team_id")?;
            uuid::Uuid::parse_str(id).map_err(|_| "invalid team ID")?;
            let name = get("name")?.trim();
            if name.is_empty() || name.len() > 120 {
                return Err("invalid team name".into());
            }
            let changed = tx.execute("UPDATE team_records SET name=?1,updated_at=?2,sync_status='pending',sync_error=NULL WHERE account_id=?3 AND id=?4", rusqlite::params![name,now,account_id,id]).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("team not found locally".into());
            }
        }
        "team.delete" => {
            let id = get("team_id")?;
            uuid::Uuid::parse_str(id).map_err(|_| "invalid team ID")?;
            let changed = tx
                .execute(
                    "DELETE FROM team_records WHERE account_id=?1 AND id=?2",
                    rusqlite::params![account_id, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("team not found locally".into());
            }
        }
        "member.remove" | "member.role" => {
            let team_id = get("team_id")?;
            let user_id = get("user_id")?;
            uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
            uuid::Uuid::parse_str(user_id).map_err(|_| "invalid member ID")?;
            if operation_type == "member.remove" {
                tx.execute(
                    "DELETE FROM team_members WHERE account_id=?1 AND team_id=?2 AND user_id=?3",
                    rusqlite::params![account_id, team_id, user_id],
                )
                .map_err(|e| e.to_string())?;
            } else {
                let role = get("role")?;
                if role != "member" && role != "admin" {
                    return Err("invalid team role".into());
                }
                let changed = tx.execute("UPDATE team_members SET role=?1 WHERE account_id=?2 AND team_id=?3 AND user_id=?4", rusqlite::params![role,account_id,team_id,user_id]).map_err(|e| e.to_string())?;
                if changed == 0 {
                    return Err("team member not found locally".into());
                }
            }
        }
        "vault.create" => {
            let id = get("vault_id")?;
            let team_id = get("team_id")?;
            let name = get("name")?.trim();
            uuid::Uuid::parse_str(id).map_err(|_| "invalid vault ID")?;
            uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
            if name.is_empty() || name.len() > 120 {
                return Err("invalid vault name".into());
            }
            let owner_id: String = tx
                .query_row(
                    "SELECT owner_id FROM team_records WHERE account_id=?1 AND id=?2",
                    rusqlite::params![account_id, team_id],
                    |row| row.get(0),
                )
                .map_err(|_| "team not found locally")?;
            tx.execute("INSERT INTO vaults (id,revision,vault_id,created_at,updated_at,owner_id,kind,name,data) VALUES (?1,1,'',?2,?2,?3,'team',?4,'{}') ON CONFLICT(id) DO NOTHING", rusqlite::params![id,now,owner_id,name]).map_err(|e| e.to_string())?;
        }
        "vault.rotate" => {
            let id = get("vault_id")?;
            let team_id = get("team_id")?;
            uuid::Uuid::parse_str(id).map_err(|_| "invalid vault ID")?;
            uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
            let changed = tx.execute(
                "UPDATE team_vaults SET rotation_state='rotation_pending' WHERE vault_id=?1 AND team_id=?2 AND rotation_state='rotation_required'",
                rusqlite::params![id, team_id],
            ).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("team vault is not awaiting rotation".into());
            }
        }
        "vault.rename" | "vault.delete" => {
            let id = get("vault_id")?;
            uuid::Uuid::parse_str(id).map_err(|_| "invalid vault ID")?;
            if operation_type == "vault.rename" {
                let name = get("name")?.trim();
                if name.is_empty() || name.len() > 120 {
                    return Err("invalid vault name".into());
                }
                let changed = tx
                    .execute(
                        "UPDATE vaults SET name=?1,updated_at=?2 WHERE id=?3 AND kind='team'",
                        rusqlite::params![name, now, id],
                    )
                    .map_err(|e| e.to_string())?;
                if changed == 0 {
                    return Err("team vault not found locally".into());
                }
            } else {
                let changed = tx
                    .execute(
                        "UPDATE vaults SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND kind='team'",
                        rusqlite::params![now, id],
                    )
                    .map_err(|e| e.to_string())?;
                if changed == 0 {
                    return Err("team vault not found locally".into());
                }
            }
        }
        "invite.accept" | "invite.decline" => {
            let invite_id = get("invite_id")?;
            uuid::Uuid::parse_str(invite_id).map_err(|_| "invalid invite ID")?;
            let state = if operation_type == "invite.accept" {
                "accept_pending"
            } else {
                "decline_pending"
            };
            tx.execute(
                "UPDATE team_invites SET status=?1 WHERE account_id=?2 AND id=?3",
                rusqlite::params![state, account_id, invite_id],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    let affected_team =
        if let Some(team_id) = value.get("team_id").and_then(serde_json::Value::as_str) {
            Some(team_id.to_owned())
        } else if let Some(vault_id) = value.get("vault_id").and_then(serde_json::Value::as_str) {
            tx.query_row(
                "SELECT team_id FROM team_vaults WHERE vault_id=?1",
                [vault_id],
                |row| row.get::<_, String>(0),
            )
            .ok()
        } else if let Some(invite_id) = value.get("invite_id").and_then(serde_json::Value::as_str) {
            tx.query_row(
                "SELECT team_id FROM team_invites WHERE account_id=?1 AND id=?2",
                rusqlite::params![account_id, invite_id],
                |row| row.get::<_, String>(0),
            )
            .ok()
        } else {
            None
        };
    if let Some(team_id) = affected_team {
        tx.execute("UPDATE team_records SET sync_status='pending',sync_error=NULL,updated_at=?1 WHERE account_id=?2 AND id=?3", rusqlite::params![now,account_id,team_id]).map_err(|e| e.to_string())?;
    }
    tx.execute("INSERT INTO team_outbox (account_id,operation_id,operation_type,payload,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'pending',?5,?5)",
        rusqlite::params![account_id, operation_id, operation_type, payload, now]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(operation_id)
}

pub fn pending_team_operations(
    db: &LocalDb,
    account_id: &str,
    limit: usize,
) -> Result<Vec<TeamOutboxOperation>, String> {
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT account_id,operation_id,operation_type,payload,status,error,created_at FROM team_outbox WHERE account_id=?1 AND status='pending' ORDER BY created_at,operation_id LIMIT ?2").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![account_id, limit.min(50) as i64], |row| {
            Ok(TeamOutboxOperation {
                account_id: row.get(0)?,
                operation_id: row.get(1)?,
                operation_type: row.get(2)?,
                payload: row.get(3)?,
                status: row.get(4)?,
                error: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn update_team_operation_payload(
    db: &LocalDb,
    account_id: &str,
    operation_id: &str,
    payload: &str,
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(operation_id).map_err(|_| "invalid operation ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let changed = conn.execute(
        "UPDATE team_outbox SET payload=?1,updated_at=?2 WHERE account_id=?3 AND operation_id=?4 AND status='pending'",
        rusqlite::params![payload, now_iso(), account_id, operation_id],
    ).map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("pending team operation not found".into());
    }
    Ok(())
}

pub fn acknowledge_team_operation(
    db: &LocalDb,
    account_id: &str,
    operation_id: &str,
    error: Option<&str>,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(operation_id).map_err(|_| "invalid operation ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let operation: Option<(String, String)> = conn.query_row(
        "SELECT operation_type,payload FROM team_outbox WHERE account_id=?1 AND operation_id=?2",
        rusqlite::params![account_id, operation_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if let Some((operation_type, payload)) = operation {
        let value: serde_json::Value =
            serde_json::from_str(&payload).map_err(|_| "invalid queued team operation")?;
        let team_id = value
            .get("team_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                value
                    .get("vault_id")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|vault_id| {
                        conn.query_row(
                            "SELECT team_id FROM team_vaults WHERE vault_id=?1",
                            [vault_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    })
            })
            .or_else(|| {
                value
                    .get("invite_id")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|invite_id| {
                        conn.query_row(
                            "SELECT team_id FROM team_invites WHERE account_id=?1 AND id=?2",
                            rusqlite::params![account_id, invite_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    })
            });
        if let Some(team_id) = team_id.as_deref() {
            if error.is_some() {
                conn.execute("UPDATE team_records SET sync_status='rejected',sync_error=?1 WHERE account_id=?2 AND id=?3", rusqlite::params![error,account_id,team_id]).map_err(|e| e.to_string())?;
            } else {
                conn.execute("UPDATE team_records SET sync_status='synced',sync_error=NULL WHERE account_id=?1 AND id=?2", rusqlite::params![account_id,team_id]).map_err(|e| e.to_string())?;
            }
            if error.is_none() && operation_type == "team.delete" {
                conn.execute(
                    "UPDATE team_vaults SET rotation_state='revoked' WHERE team_id=?1",
                    [team_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if let Some(vault_id) = value.get("vault_id").and_then(serde_json::Value::as_str) {
            if error.is_some() && operation_type == "vault.create" {
                let now = now_iso();
                conn.execute(
                    "UPDATE vaults SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND kind='team'",
                    rusqlite::params![now, vault_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE team_vaults SET rotation_state='revoked' WHERE vault_id=?1",
                    [vault_id],
                )
                .map_err(|e| e.to_string())?;
            } else if error.is_none() && operation_type == "vault.delete" {
                conn.execute(
                    "UPDATE team_vaults SET rotation_state='revoked' WHERE vault_id=?1",
                    [vault_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if error.is_some() && matches!(operation_type.as_str(), "invite.accept" | "invite.decline") {
            if let Some(invite_id) = value.get("invite_id").and_then(serde_json::Value::as_str) {
                conn.execute(
                    "UPDATE team_invites SET status='sync_rejected' WHERE account_id=?1 AND id=?2",
                    rusqlite::params![account_id, invite_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if error.is_some() && operation_type == "vault.rotate" {
            if let Some(vault_id) = value.get("vault_id").and_then(serde_json::Value::as_str) {
                conn.execute(
                    "UPDATE team_vaults SET rotation_state='rotation_required' WHERE vault_id=?1 AND rotation_state='rotation_pending'",
                    [vault_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(error) = error {
        conn.execute("UPDATE team_outbox SET status='rejected',error=?1,updated_at=?2 WHERE account_id=?3 AND operation_id=?4", rusqlite::params![error, now_iso(), account_id, operation_id]).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "DELETE FROM team_outbox WHERE account_id=?1 AND operation_id=?2",
            rusqlite::params![account_id, operation_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn team_sync_cursor(db: &LocalDb, account_id: &str) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT cursor FROM team_sync_state WHERE account_id=?1",
        [account_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn store_team_sync_cursor(
    db: &LocalDb,
    account_id: &str,
    cursor: Option<&str>,
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO team_sync_state (account_id,cursor,updated_at) VALUES (?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at", rusqlite::params![account_id,cursor,now_iso()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_team_sync_status(
    db: &LocalDb,
    account_id: &str,
    team_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    if status != "pending" && status != "synced" && status != "rejected" {
        return Err("invalid team sync status".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE team_records SET sync_status=?1,sync_error=?2 WHERE account_id=?3 AND id=?4",
        rusqlite::params![status, error, account_id, team_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn import_team_vault_metadata(
    db: &LocalDb,
    vault_id: &str,
    team_id: &str,
    owner_id: &str,
    name: &str,
    epoch: u32,
    rotation_state: &str,
) -> Result<(), String> {
    for id in [vault_id, team_id, owner_id] {
        uuid::Uuid::parse_str(id).map_err(|_| "invalid team vault metadata ID")?;
    }
    if name.trim().is_empty() || epoch == 0 || rotation_state.is_empty() {
        return Err("invalid team vault metadata".into());
    }
    use rusqlite::OptionalExtension;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let existing: Option<(String, u32, String)> = tx
        .query_row(
            "SELECT team_id, epoch, rotation_state FROM team_vaults WHERE vault_id = ?1",
            [vault_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let row_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vaults WHERE id = ?1)",
            [vault_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if existing.is_none() && row_exists {
        return Err("cannot convert existing private vault into team vault".into());
    }
    if let Some((stored_team, stored_epoch, stored_state)) = existing {
        if stored_team != team_id || epoch < stored_epoch {
            return Err("team vault identity or epoch rollback".into());
        }
        if stored_state == "revoked" && epoch == stored_epoch && rotation_state != "revoked" {
            return Err("revoked team vault requires a newer key epoch".into());
        }
    }
    tx.execute("INSERT INTO team_vaults (vault_id, team_id, epoch, rotation_state) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(vault_id) DO UPDATE SET epoch = excluded.epoch, rotation_state = excluded.rotation_state",
        rusqlite::params![vault_id, team_id, epoch, rotation_state]).map_err(|e| e.to_string())?;
    let now = now_iso();
    tx.execute("INSERT INTO vaults (id, revision, vault_id, created_at, updated_at, owner_id, kind, name, data)
        VALUES (?1, 1, '', ?2, ?2, ?3, 'team', ?4, '{}')
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, deleted_at = NULL",
        rusqlite::params![vault_id, now, owner_id, name.trim()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn team_vault_has_row(db: &LocalDb, vault_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM vaults WHERE id = ?1)",
        [vault_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn store_team_vault_meta(
    db: &LocalDb,
    vault_id: &str,
    team_id: &str,
    epoch: u32,
    rotation_state: &str,
) -> Result<(), String> {
    if vault_id.is_empty() || team_id.is_empty() || epoch == 0 || rotation_state.is_empty() {
        return Err("invalid team vault metadata".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let changed = conn.execute("INSERT INTO team_vaults (vault_id, team_id, epoch, rotation_state) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(vault_id) DO UPDATE SET epoch = excluded.epoch, rotation_state = excluded.rotation_state
        WHERE team_vaults.team_id = excluded.team_id AND excluded.epoch >= team_vaults.epoch
        AND NOT (team_vaults.rotation_state = 'revoked' AND excluded.epoch = team_vaults.epoch AND excluded.rotation_state <> 'revoked')",
        rusqlite::params![vault_id, team_id, epoch, rotation_state]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("team vault identity or epoch rollback".into());
    }
    Ok(())
}

pub fn team_vault_meta(
    db: &LocalDb,
    vault_id: &str,
) -> Result<Option<(String, u32, String)>, String> {
    use rusqlite::OptionalExtension;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT team_id, epoch, rotation_state FROM team_vaults WHERE vault_id = ?1",
        [vault_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn revoke_cached_team_vault(db: &LocalDb, vault_id: &str) -> Result<usize, String> {
    uuid::Uuid::parse_str(vault_id).map_err(|_| "invalid team vault ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE team_vaults SET rotation_state = 'revoked' WHERE vault_id = ?1",
        [vault_id],
    )
    .map_err(|e| e.to_string())
}

pub fn revoke_cached_team(db: &LocalDb, team_id: &str) -> Result<usize, String> {
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE team_vaults SET rotation_state = 'revoked' WHERE team_id = ?1",
        [team_id],
    )
    .map_err(|e| e.to_string())
}

pub fn revoke_cached_team_for_account(
    db: &LocalDb,
    account_id: &str,
    team_id: &str,
) -> Result<usize, String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(team_id).map_err(|_| "invalid team ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE team_vaults SET rotation_state='revoked' WHERE team_id=?1",
        [team_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM team_members WHERE account_id=?1 AND team_id=?2",
        rusqlite::params![account_id, team_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM team_invites WHERE account_id=?1 AND team_id=?2",
        rusqlite::params![account_id, team_id],
    )
    .map_err(|e| e.to_string())?;
    let removed = tx
        .execute(
            "DELETE FROM team_records WHERE account_id=?1 AND id=?2",
            rusqlite::params![account_id, team_id],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

pub fn revoke_cached_team_vault_for_account(
    db: &LocalDb,
    account_id: &str,
    vault_id: &str,
) -> Result<usize, String> {
    validate_team_account_id(account_id)?;
    uuid::Uuid::parse_str(vault_id).map_err(|_| "invalid team vault ID")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = now_iso();
    conn.execute("UPDATE team_vaults SET rotation_state='revoked' WHERE vault_id=?1 AND EXISTS (SELECT 1 FROM team_records tr WHERE tr.id=team_vaults.team_id AND tr.account_id=?2)", rusqlite::params![vault_id,account_id]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE vaults SET deleted_at=COALESCE(deleted_at,?1),updated_at=?1 WHERE id=?2 AND kind='team'", rusqlite::params![now,vault_id]).map_err(|e| e.to_string())
}

pub fn store_wrapped_team_key(
    db: &LocalDb,
    vault_id: &str,
    team_id: &str,
    epoch: u32,
    wrapped_key: &str,
) -> Result<(), String> {
    if vault_id.is_empty() || team_id.is_empty() || epoch == 0 || wrapped_key.is_empty() {
        return Err("invalid team key cache entry".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO team_vault_keys (vault_id, team_id, epoch, wrapped_key) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(vault_id, epoch) DO UPDATE SET wrapped_key = excluded.wrapped_key WHERE team_id = excluded.team_id",
        rusqlite::params![vault_id, team_id, epoch, wrapped_key]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_wrapped_team_key(
    db: &LocalDb,
    vault_id: &str,
    epoch: u32,
) -> Result<Option<(String, String)>, String> {
    use rusqlite::OptionalExtension;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT team_id, wrapped_key FROM team_vault_keys WHERE vault_id = ?1 AND epoch = ?2",
        rusqlite::params![vault_id, epoch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
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

        CREATE TABLE IF NOT EXISTS team_vaults (
            vault_id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            rotation_state TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS team_vault_keys (
            vault_id TEXT NOT NULL,
            team_id TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            wrapped_key TEXT NOT NULL,
            PRIMARY KEY (vault_id, epoch)
        );

        CREATE TABLE IF NOT EXISTS team_records (
            account_id TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            sync_status TEXT NOT NULL DEFAULT 'synced', sync_error TEXT,
            PRIMARY KEY(account_id, id)
        );
        CREATE TABLE IF NOT EXISTS team_members (
            account_id TEXT NOT NULL, team_id TEXT NOT NULL, id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '', full_name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', public_key TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(account_id, team_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS team_invites (
            account_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL,
            email TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(account_id, id)
        );
        CREATE TABLE IF NOT EXISTS team_sync_state (
            account_id TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_cache_migrations (
            account_id TEXT PRIMARY KEY, imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_outbox (
            account_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            operation_type TEXT NOT NULL, payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', error TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(account_id, operation_id)
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

        CREATE TABLE IF NOT EXISTS sync_snapshot_state (
            vault_id TEXT PRIMARY KEY,
            boundary INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_snapshot_seen (
            vault_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            PRIMARY KEY (vault_id, table_name, record_id)
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
    for table in [
        "session_history",
        "session_output_chunks",
        "session_preferences",
    ] {
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {table} (
            id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
            vault_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            deleted_at TEXT, edited_at TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '', operation_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS idx_{table}_vault ON {table}(vault_id, sort_order);"
        ))
        .map_err(|e| format!("create {table}: {e}"))?;
    }
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
        ("team_records", "owner_id", "TEXT NOT NULL DEFAULT ''"),
        ("team_members", "id", "TEXT NOT NULL DEFAULT ''"),
        ("team_members", "public_key", "TEXT NOT NULL DEFAULT ''"),
        ("team_members", "fingerprint", "TEXT NOT NULL DEFAULT ''"),
        ("team_invites", "expires_at", "TEXT NOT NULL DEFAULT ''"),
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
        "session_history",
        "session_output_chunks",
        "session_preferences",
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
        Table::SessionHistory | Table::SessionOutputChunks | Table::SessionPreferences => "name, sort_order, data",
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
            "session_history",
            &["created_at", "updated_at", "deleted_at"],
        ),
        (
            "session_output_chunks",
            &["created_at", "updated_at", "deleted_at"],
        ),
        (
            "session_preferences",
            &["created_at", "updated_at", "deleted_at"],
        ),
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
            "session_history" => Ok(Table::SessionHistory),
            "session_output_chunks" => Ok(Table::SessionOutputChunks),
            "session_preferences" => Ok(Table::SessionPreferences),
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
            Table::SessionHistory => "session_history",
            Table::SessionOutputChunks => "session_output_chunks",
            Table::SessionPreferences => "session_preferences",
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
    if matches!(
        table,
        Table::SessionHistory | Table::SessionOutputChunks | Table::SessionPreferences
    ) {
        let allowed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM vaults v WHERE v.id = ?1 AND v.kind = 'personal' AND v.is_default = 1 AND v.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM team_vaults tv WHERE tv.vault_id = v.id))",
            [&row.vault_id],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if !allowed {
            return Err("history requires default personal vault".into());
        }
    }
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

/// Tombstone related synced records and queue every deletion atomically.
pub fn tombstone_sync_rows_with_device(
    db: &LocalDb,
    rows: &[(Table, String)],
    device_id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(device_id).map_err(|_| "invalid device ID")?;
    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso();
    for (table, id) in rows {
        let Some(mut row) = get_sync_row_unlocked(&tx, *table, id)? else {
            continue;
        };
        if row.deleted_at.is_some() {
            continue;
        }
        row.revision += 1;
        row.updated_at = now.clone();
        row.edited_at = now.clone();
        row.deleted_at = Some(now.clone());
        row.device_id = device_id.into();
        row.operation_id = uuid::Uuid::new_v4().to_string();
        sync_db::write_row(&tx, *table, &row)?;
        sync_db::queue_row(&tx, *table, &row, &now)?;
    }
    tx.commit().map_err(|e| e.to_string())
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
        Table::SessionHistory,
        Table::SessionOutputChunks,
        Table::SessionPreferences,
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
    SessionHistory,
    SessionOutputChunks,
    SessionPreferences,
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
    fn desktop_database_filename_uses_terra_identity() {
        assert_eq!(DB_FILE_NAME, "terra.db");
    }

    #[test]
    fn sync_db_migrates_legacy_outbox_to_stable_iso_operation() {
        let path =
            std::env::temp_dir().join(format!("terra-sync-migration-{}.db", uuid::Uuid::new_v4()));
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
    fn imported_team_vault_is_visible_without_sync_outbox() {
        let db = test_db();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let team_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        import_team_vault_metadata(&db, &vault_id, &team_id, &owner_id, "Shared", 1, "ready")
            .unwrap();
        let vaults = list_sync_rows(&db, Table::Vaults, "", false).unwrap();
        assert_eq!(
            vaults
                .iter()
                .find(|row| row.id == vault_id)
                .unwrap()
                .name
                .as_deref(),
            Some("Shared")
        );
        assert!(outbox_pending(&db).unwrap().is_empty());
        assert_eq!(team_vault_meta(&db, &vault_id).unwrap().unwrap().0, team_id);
        assert!(import_team_vault_metadata(
            &db,
            &vault_id,
            &uuid::Uuid::new_v4().to_string(),
            &owner_id,
            "Wrong",
            1,
            "ready"
        )
        .is_err());
        store_team_vault_meta(&db, &vault_id, &team_id, 1, "revoked").unwrap();
        assert!(import_team_vault_metadata(
            &db, &vault_id, &team_id, &owner_id, "Stale", 1, "ready"
        )
        .is_err());
        assert_eq!(
            team_vault_meta(&db, &vault_id).unwrap().unwrap().2,
            "revoked"
        );
    }

    #[test]
    fn history_rows_cannot_be_queued_in_team_vaults() {
        let db = test_db();
        let vault_id = uuid::Uuid::new_v4().to_string();
        let team_id = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        import_team_vault_metadata(&db, &vault_id, &team_id, &owner_id, "Shared", 1, "ready")
            .unwrap();
        for table in [
            Table::SessionHistory,
            Table::SessionOutputChunks,
            Table::SessionPreferences,
        ] {
            let row = SyncRow {
                id: uuid::Uuid::new_v4().to_string(),
                vault_id: vault_id.clone(),
                name: Some("Session".into()),
                data: "ciphertext".into(),
                ..SyncRow::default()
            };
            assert!(local_mutate(&db, table, &row, &device_id).is_err());
        }
        assert!(outbox_pending(&db).unwrap().is_empty());
    }

    #[test]
    fn confirmed_deletions_revoke_only_matching_cached_team_vaults() {
        let db = test_db();
        let team_id = uuid::Uuid::new_v4().to_string();
        let other_team_id = uuid::Uuid::new_v4().to_string();
        let vault_a = uuid::Uuid::new_v4().to_string();
        let vault_b = uuid::Uuid::new_v4().to_string();
        let other_vault = uuid::Uuid::new_v4().to_string();
        let owner_id = uuid::Uuid::new_v4().to_string();
        for (vault_id, team) in [
            (&vault_a, &team_id),
            (&vault_b, &team_id),
            (&other_vault, &other_team_id),
        ] {
            import_team_vault_metadata(&db, vault_id, team, &owner_id, "Shared", 1, "ready")
                .unwrap();
        }
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO outbox (table_name, record_id, queued_at, vault_id) VALUES ('hosts', 'pending-host', '2026-10-02T00:00:00.000Z', ?1)",
                [&vault_a],
            ).unwrap();
        }
        assert_eq!(revoke_cached_team_vault(&db, &vault_a).unwrap(), 1);
        assert_eq!(
            team_vault_meta(&db, &vault_a).unwrap().unwrap().2,
            "revoked"
        );
        assert_eq!(team_vault_meta(&db, &vault_b).unwrap().unwrap().2, "ready");
        assert_eq!(revoke_cached_team(&db, &team_id).unwrap(), 2);
        assert_eq!(
            team_vault_meta(&db, &vault_b).unwrap().unwrap().2,
            "revoked"
        );
        assert_eq!(
            team_vault_meta(&db, &other_vault).unwrap().unwrap().2,
            "ready"
        );
        let conn = db.conn.lock().unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE record_id = 'pending-host'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
        assert_eq!(
            revoke_cached_team(&db, "invalid"),
            Err("invalid team ID".into())
        );
    }

    #[test]
    fn team_vault_marker_prevents_personal_key_fallback() {
        let db = test_db();
        assert_eq!(team_vault_meta(&db, "vault-1").unwrap(), None);
        store_team_vault_meta(&db, "vault-1", "team-1", 1, "ready").unwrap();
        assert_eq!(
            team_vault_meta(&db, "vault-1").unwrap(),
            Some(("team-1".into(), 1, "ready".into()))
        );
        store_team_vault_meta(&db, "vault-1", "team-1", 2, "ready").unwrap();
        store_team_vault_meta(&db, "vault-1", "team-1", 2, "revoked").unwrap();
        assert!(store_team_vault_meta(&db, "vault-1", "team-1", 2, "ready").is_err());
        assert!(store_team_vault_meta(&db, "vault-1", "team-1", 1, "ready").is_err());
        assert!(store_team_vault_meta(&db, "vault-1", "other-team", 2, "ready").is_err());
        wipe_all(&db).unwrap();
        assert_eq!(team_vault_meta(&db, "vault-1").unwrap(), None);
    }

    #[test]
    fn team_key_cache_is_wrapped_and_wiped() {
        let db = test_db();
        store_wrapped_team_key(&db, "vault-1", "team-1", 1, "wrapped-ciphertext").unwrap();
        assert_eq!(
            load_wrapped_team_key(&db, "vault-1", 1).unwrap(),
            Some(("team-1".into(), "wrapped-ciphertext".into()))
        );
        assert_eq!(load_wrapped_team_key(&db, "vault-1", 2).unwrap(), None);
        wipe_all(&db).unwrap();
        assert_eq!(load_wrapped_team_key(&db, "vault-1", 1).unwrap(), None);
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
            "session_history",
            "session_output_chunks",
            "session_preferences",
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

#[cfg(test)]
mod team_sync_tests {
    use super::*;

    #[test]
    fn team_snapshots_and_outbox_are_account_scoped_and_durable() {
        let db = open(":memory:").unwrap();
        let now = "2026-10-04T00:00:00.000Z";
        let account_id = "d31e18e3-613b-4656-a085-4688c40b7890";
        let other_account_id = "8e7b3d3a-9f6d-4a52-a7d1-e7088f48da68";
        let team = TeamRecord {
            account_id: account_id.into(),
            id: "73ca4a95-574e-4174-a255-e45169ca7494".into(),
            owner_id: account_id.into(),
            name: "Alpha".into(),
            created_at: now.into(),
            updated_at: now.into(),
            sync_status: "synced".into(),
            sync_error: None,
        };
        upsert_team(&db, &team).unwrap();
        assert_eq!(list_teams(&db, account_id).unwrap(), vec![team]);
        assert!(list_teams(&db, other_account_id).unwrap().is_empty());

        let operation_id = enqueue_team_operation(
            &db,
            account_id,
            "team.rename",
            r#"{"team_id":"73ca4a95-574e-4174-a255-e45169ca7494","name":"Renamed"}"#,
        )
        .unwrap();
        let pending = pending_team_operations(&db, account_id, 50).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation_id, operation_id);
        assert_eq!(pending[0].operation_type, "team.rename");
        assert!(pending_team_operations(&db, other_account_id, 50)
            .unwrap()
            .is_empty());

        acknowledge_team_operation(&db, account_id, &operation_id, None).unwrap();
        assert!(pending_team_operations(&db, account_id, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn invalid_team_operation_does_not_write_an_outbox_row() {
        let db = open(":memory:").unwrap();
        assert!(enqueue_team_operation(
            &db,
            "d31e18e3-613b-4656-a085-4688c40b7890",
            "invalid",
            "{}"
        )
        .is_err());
        assert!(pending_team_operations(&db, "not-a-uuid", 50).is_err());
    }

    #[test]
    fn member_and_invitation_snapshots_are_scoped_by_account() {
        let db = open(":memory:").unwrap();
        let account_id = "d31e18e3-613b-4656-a085-4688c40b7890";
        let other_account_id = "8e7b3d3a-9f6d-4a52-a7d1-e7088f48da68";
        let team_id = "73ca4a95-574e-4174-a255-e45169ca7494";
        let member = TeamMemberRecord {
            account_id: account_id.into(),
            team_id: team_id.into(),
            id: "c8d6eeed-99b9-4e15-89e5-0da1d962a5e4".into(),
            user_id: "d431ba16-5ec2-4431-a1b5-3f7908b97b07".into(),
            email: "member@example.com".into(),
            full_name: "Member".into(),
            role: "member".into(),
            created_at: "2026-10-04T00:00:00.000Z".into(),
            public_key: "".into(),
            fingerprint: "".into(),
        };
        replace_team_members(&db, account_id, team_id, &[member.clone()]).unwrap();
        assert_eq!(
            list_team_members(&db, account_id, team_id).unwrap(),
            vec![member]
        );
        assert!(list_team_members(&db, other_account_id, team_id)
            .unwrap()
            .is_empty());
        let invite = TeamInviteRecord {
            account_id: account_id.into(),
            id: "de84a26e-5008-44a7-aa2b-1a4dd3af86bd".into(),
            team_id: team_id.into(),
            email: "pending@example.com".into(),
            role: "member".into(),
            status: "pending".into(),
            created_at: "2026-10-04T00:00:00.000Z".into(),
            expires_at: "2026-10-11T00:00:00.000Z".into(),
        };
        replace_team_invites(&db, account_id, &[invite.clone()]).unwrap();
        assert_eq!(list_team_invites(&db, account_id).unwrap(), vec![invite]);
        assert!(list_team_invites(&db, other_account_id).unwrap().is_empty());
    }
}
