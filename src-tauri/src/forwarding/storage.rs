use super::model::{validate, ForwardDefinition, ForwardInput, ForwardMode};
use crate::db::LocalDb;
use rusqlite::{params, Row};

const COLUMNS: &str = "id, host_id, mode, name, local_port, remote_bind_address, remote_port, destination_host, destination_port";

fn from_row(row: &Row<'_>) -> rusqlite::Result<ForwardDefinition> {
    let mode: String = row.get(2)?;
    let mode = ForwardMode::parse(&mode).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, e.into())
    })?;
    Ok(ForwardDefinition {
        id: row.get(0)?,
        host_id: row.get(1)?,
        mode,
        name: row.get(3)?,
        local_port: row.get(4)?,
        remote_bind_address: row.get(5)?,
        remote_port: row.get(6)?,
        destination_host: row.get(7)?,
        destination_port: row.get(8)?,
    })
}

fn definition(id: String, input: ForwardInput) -> ForwardDefinition {
    ForwardDefinition {
        id,
        host_id: input.host_id,
        mode: input.mode,
        name: input.name,
        local_port: input.local_port,
        remote_bind_address: input.remote_bind_address,
        remote_port: input.remote_port,
        destination_host: input.destination_host,
        destination_port: input.destination_port,
    }
}

fn prune(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM port_forwards WHERE host_id NOT IN (SELECT id FROM hosts WHERE deleted_at IS NULL)",
        [],
    ).map_err(|e| format!("prune port forwards: {e}"))?;
    Ok(())
}

pub fn get(db: &LocalDb, id: &str) -> Result<ForwardDefinition, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    prune(&conn)?;
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM port_forwards WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|_| "Saved port forward does not exist".to_string())
}

pub fn list(db: &LocalDb, host_id: &str) -> Result<Vec<ForwardDefinition>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    prune(&conn)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM port_forwards WHERE host_id = ?1 ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([host_id], from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn create(db: &LocalDb, input: ForwardInput) -> Result<ForwardDefinition, String> {
    validate(&input)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    prune(&conn)?;
    let id = uuid::Uuid::new_v4().to_string();
    let result = conn.execute(
        "INSERT INTO port_forwards (id, host_id, mode, name, local_port, remote_bind_address, remote_port, destination_host, destination_port)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
         WHERE EXISTS (SELECT 1 FROM hosts WHERE id = ?2 AND deleted_at IS NULL)",
        params![id, input.host_id, input.mode.as_str(), input.name, input.local_port,
            input.remote_bind_address, input.remote_port, input.destination_host, input.destination_port],
    ).map_err(|e| format!("create forward: {e}"))?;
    if result == 0 {
        return Err("Saved host does not exist".into());
    }
    Ok(definition(id, input))
}

pub fn update(db: &LocalDb, id: &str, input: ForwardInput) -> Result<ForwardDefinition, String> {
    validate(&input)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    prune(&conn)?;
    let changed = conn
        .execute(
            "UPDATE port_forwards SET host_id = ?2, mode = ?3, name = ?4, local_port = ?5,
         remote_bind_address = ?6, remote_port = ?7, destination_host = ?8, destination_port = ?9
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM hosts WHERE id = ?2 AND deleted_at IS NULL)",
            params![
                id,
                input.host_id,
                input.mode.as_str(),
                input.name,
                input.local_port,
                input.remote_bind_address,
                input.remote_port,
                input.destination_host,
                input.destination_port
            ],
        )
        .map_err(|e| format!("update forward: {e}"))?;
    if changed == 0 {
        return Err("Forward or saved host does not exist".into());
    }
    Ok(definition(id.to_string(), input))
}

pub fn delete(db: &LocalDb, id: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM port_forwards WHERE id = ?1", [id])
        .map_err(|e| format!("delete forward: {e}"))?;
    Ok(())
}

pub fn delete_for_host(db: &LocalDb, host_id: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM port_forwards WHERE host_id = ?1", [host_id])
        .map_err(|e| format!("delete forwards for host: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forwarding::model::ForwardInput;

    fn host(db: &crate::db::LocalDb, id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO hosts (id, vault_id, created_at, updated_at, name) VALUES (?1, 'v1', 1, 1, 'host')", [id]).unwrap();
    }

    #[test]
    fn create_update_delete_round_trip() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        let saved = create(&db, ForwardInput::local("h1", "web", 8080, "localhost", 80)).unwrap();
        assert_eq!(list(&db, "h1").unwrap()[0].id, saved.id);
        assert_eq!(get(&db, &saved.id).unwrap(), saved);
        let edited = update(&db, &saved.id, ForwardInput::dynamic("h1", "socks", 1080)).unwrap();
        assert_eq!(edited.id, saved.id);
        assert_eq!(list(&db, "h1").unwrap()[0].name, "socks");
        delete(&db, &saved.id).unwrap();
        assert!(get(&db, &saved.id).is_err());
        assert!(list(&db, "h1").unwrap().is_empty());
    }

    #[test]
    fn list_prunes_deleted_or_missing_hosts() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        create(&db, ForwardInput::dynamic("h1", "socks", 1080)).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE hosts SET deleted_at = 2 WHERE id = 'h1'", [])
            .unwrap();
        assert!(list(&db, "h1").unwrap().is_empty());
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM port_forwards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_unknown_hosts_and_removes_all_for_host() {
        let db = crate::db::open(":memory:").unwrap();
        assert!(create(&db, ForwardInput::dynamic("absent", "socks", 1080)).is_err());
        host(&db, "h1");
        create(&db, ForwardInput::dynamic("h1", "first", 1080)).unwrap();
        create(&db, ForwardInput::dynamic("h1", "second", 1081)).unwrap();
        delete_for_host(&db, "h1").unwrap();
        assert!(list(&db, "h1").unwrap().is_empty());
    }

    #[test]
    fn wipe_removes_saved_forwards() {
        let db = crate::db::open(":memory:").unwrap();
        host(&db, "h1");
        create(&db, ForwardInput::local("h1", "web", 8080, "localhost", 80)).unwrap();
        crate::db::wipe_all(&db).unwrap();
        assert!(list(&db, "h1").unwrap().is_empty());
    }
}
