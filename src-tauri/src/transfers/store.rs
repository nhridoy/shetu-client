//! The saved queue: one row per job in `shetu.db`'s `transfer_jobs` table (JSON payload).

use super::model::TransferJob;
use crate::db::LocalDb;

pub fn save_job(db: &LocalDb, job: &TransferJob) -> Result<(), String> {
    let mut row = job.clone();
    row.speed = 0.0;
    let data = serde_json::to_string(&row).map_err(|e| e.to_string())?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO transfer_jobs (id, created_at, data) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        rusqlite::params![job.id, job.created_at, data],
    )
    .map_err(|e| format!("save transfer: {e}"))?;
    Ok(())
}

pub fn delete_jobs(db: &LocalDb, ids: &[String]) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for id in ids {
        conn.execute("DELETE FROM transfer_jobs WHERE id = ?1", [id])
            .map_err(|e| format!("delete transfer: {e}"))?;
    }
    Ok(())
}

/// Oldest first. Rows that no longer parse are dropped.
pub fn load_jobs(db: &LocalDb) -> Result<Vec<TransferJob>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // Read the payload as any SQLite value: one non-text row must not fail the whole load.
    let rows: Vec<(String, rusqlite::types::Value)> = conn
        .prepare("SELECT id, data FROM transfer_jobs ORDER BY created_at, rowid")
        .and_then(|mut stmt| {
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .map_err(|e| format!("load transfers: {e}"))?;
    let mut jobs = Vec::new();
    for (id, data) in rows {
        let parsed = match data {
            rusqlite::types::Value::Text(text) => serde_json::from_str::<TransferJob>(&text).ok(),
            _ => None,
        };
        match parsed {
            Some(job) => jobs.push(job),
            None => {
                conn.execute("DELETE FROM transfer_jobs WHERE id = ?1", [&id])
                    .map_err(|e| format!("delete transfer: {e}"))?;
            }
        }
    }
    Ok(jobs)
}

pub fn clear_jobs(db: &LocalDb) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM transfer_jobs", [])
        .map_err(|e| format!("clear transfers: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfers::model::JobStatus;
    use crate::transfers::queue::test_job;

    fn db() -> LocalDb {
        crate::db::open(":memory:").unwrap()
    }

    #[test]
    fn save_load_roundtrip_keeps_order() {
        let db = db();
        let mut b = test_job("b", JobStatus::Queued);
        b.created_at = 2;
        let mut a = test_job("a", JobStatus::Paused);
        a.created_at = 1;
        a.speed = 99.0;
        save_job(&db, &b).unwrap();
        save_job(&db, &a).unwrap();
        let loaded = load_jobs(&db).unwrap();
        assert_eq!(
            loaded.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(loaded[0].speed, 0.0, "speed isn't saved");
        a.speed = 0.0;
        assert_eq!(loaded[0], a);
    }

    #[test]
    fn save_is_upsert() {
        let db = db();
        let mut a = test_job("a", JobStatus::Queued);
        save_job(&db, &a).unwrap();
        a.status = JobStatus::Failed;
        save_job(&db, &a).unwrap();
        let loaded = load_jobs(&db).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].status, JobStatus::Failed);
    }

    #[test]
    fn delete_and_clear() {
        let db = db();
        for id in ["a", "b", "c"] {
            save_job(&db, &test_job(id, JobStatus::Queued)).unwrap();
        }
        delete_jobs(&db, &["b".to_string()]).unwrap();
        assert_eq!(load_jobs(&db).unwrap().len(), 2);
        clear_jobs(&db).unwrap();
        assert!(load_jobs(&db).unwrap().is_empty());
    }

    #[test]
    fn binary_row_is_skipped_and_the_rest_load() {
        let db = db();
        save_job(&db, &test_job("good", JobStatus::Paused)).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO transfer_jobs (id, created_at, data) VALUES ('blob', 0, X'FF')",
                [],
            )
            .unwrap();
        let loaded = load_jobs(&db).unwrap();
        assert_eq!(
            loaded.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            vec!["good"]
        );
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM transfer_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rows_saved_before_expect_dest_still_load() {
        let db = db();
        let mut json = serde_json::to_value(test_job("old", JobStatus::Paused)).unwrap();
        json.as_object_mut().unwrap().remove("expectDest");
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO transfer_jobs (id, created_at, data) VALUES ('old', 0, ?1)",
                [json.to_string()],
            )
            .unwrap();
        let loaded = load_jobs(&db).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].expect_dest, None);
    }

    #[test]
    fn bad_row_is_skipped_and_removed() {
        let db = db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO transfer_jobs (id, created_at, data) VALUES ('x', 1, 'not json')",
                [],
            )
            .unwrap();
        assert!(load_jobs(&db).unwrap().is_empty());
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM transfer_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
