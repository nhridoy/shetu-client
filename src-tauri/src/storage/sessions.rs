//! Open bucket panes (pane id → operator) and the commands a bucket pane uses.

use super::accounts::{load_account, operator_for};
use super::ops::{self, StorageEntry};
use crate::db::LocalDb;
use crate::transfers::model::StorageRef;
use crate::CryptoState;
use opendal::Operator;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// Largest object `storage_read` opens in the app.
const READ_MAX: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct StorageSessions {
    open: Mutex<HashMap<String, (StorageRef, Operator)>>,
    /// Advanced by every sign-out, under the `open` lock.
    generation: std::sync::atomic::AtomicU64,
}

/// An operator for a saved account's bucket, built from the encrypted store.
pub fn operator_from_store(
    db: &LocalDb,
    crypto: &CryptoState,
    r: &StorageRef,
) -> Result<Operator, String> {
    let mut account = load_account(db, crypto, &r.account_id)?;
    account.bucket = r.bucket.clone();
    operator_for(&account)
}

impl StorageSessions {
    pub fn get(&self, sid: &str) -> Option<(StorageRef, Operator)> {
        self.open.lock().ok()?.get(sid).cloned()
    }

    /// Taken when a connect starts; see `insert_if`.
    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Stores a session only if no sign-out happened since `started`, so a connect still in
    /// flight at sign-out can't leave a bucket (and its credentials) open afterwards.
    pub fn insert_if(&self, started: u64, sid: String, r: StorageRef, op: Operator) -> bool {
        let Ok(mut open) = self.open.lock() else {
            return false;
        };
        if self.generation() != started {
            return false;
        }
        open.insert(sid, (r, op));
        true
    }

    pub fn remove(&self, sid: &str) {
        if let Ok(mut open) = self.open.lock() {
            open.remove(sid);
        }
    }

    /// Sign-out: every open bucket is forgotten.
    pub fn clear(&self) {
        if let Ok(mut open) = self.open.lock() {
            open.clear();
            self.generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// An operator for a transfer end: an open pane's on that bucket, else a new one.
    pub fn operator_for_ref(
        &self,
        app: &tauri::AppHandle,
        r: &StorageRef,
    ) -> Result<Operator, String> {
        let open = self.open.lock().ok().and_then(|o| {
            o.values()
                .find(|(seen, _)| seen == r)
                .map(|(_, op)| op.clone())
        });
        match open {
            Some(op) => Ok(op),
            None => operator_from_store(&app.state::<LocalDb>(), &app.state::<CryptoState>(), r),
        }
    }

    /// The pane's operator, only if the pane still shows `account_id`: a call already in flight
    /// when the pane reconnected to another bucket must not act on that one.
    fn op(&self, sid: &str, account_id: &str) -> Result<Operator, String> {
        match self.get(sid) {
            Some((r, op)) if r.account_id == account_id => Ok(op),
            Some(_) => Err("The pane now shows another bucket".to_string()),
            None => Err("Bucket not open — reconnect the pane".to_string()),
        }
    }
}

type Sessions<'a> = tauri::State<'a, StorageSessions>;

/// Opens a pane on an account's bucket after checking it can be listed. Returns the bucket.
#[tauri::command]
pub async fn storage_connect(
    session_id: String,
    account_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    sessions: Sessions<'_>,
) -> Result<String, String> {
    let started = sessions.generation();
    let account = load_account(&db, &crypto, &account_id)?;
    let op = operator_for(&account)?;
    ops::check_access(&op).await?;
    let bucket = account.bucket.clone();
    let r = StorageRef {
        account_id,
        bucket: account.bucket,
    };
    if !sessions.insert_if(started, session_id, r, op) {
        return Err("Signed out while the bucket was opening".into());
    }
    Ok(bucket)
}

#[tauri::command]
pub fn storage_disconnect(session_id: String, sessions: Sessions<'_>) {
    sessions.remove(&session_id);
}

#[tauri::command]
pub async fn storage_list(
    session_id: String,
    account_id: String,
    path: String,
    sessions: Sessions<'_>,
) -> Result<Vec<StorageEntry>, String> {
    ops::list_dir(&sessions.op(&session_id, &account_id)?, &path).await
}

#[tauri::command]
pub async fn storage_list_recursive(
    session_id: String,
    account_id: String,
    path: String,
    cap: usize,
    sessions: Sessions<'_>,
) -> Result<Vec<StorageEntry>, String> {
    ops::list_tree(&sessions.op(&session_id, &account_id)?, &path, cap).await
}

#[tauri::command]
pub async fn storage_stat(
    session_id: String,
    account_id: String,
    path: String,
    sessions: Sessions<'_>,
) -> Result<Option<(u64, i64)>, String> {
    ops::stat(&sessions.op(&session_id, &account_id)?, &path).await
}

#[tauri::command]
pub async fn storage_mkdir(
    session_id: String,
    account_id: String,
    path: String,
    sessions: Sessions<'_>,
) -> Result<(), String> {
    ops::mkdir(&sessions.op(&session_id, &account_id)?, &path).await
}

#[tauri::command]
pub async fn storage_delete(
    session_id: String,
    account_id: String,
    path: String,
    is_dir: bool,
    sessions: Sessions<'_>,
) -> Result<(), String> {
    ops::delete(&sessions.op(&session_id, &account_id)?, &path, is_dir).await
}

#[tauri::command]
pub async fn storage_rename(
    session_id: String,
    account_id: String,
    from: String,
    to: String,
    is_dir: bool,
    sessions: Sessions<'_>,
) -> Result<(), String> {
    ops::rename_tree(&sessions.op(&session_id, &account_id)?, &from, &to, is_dir).await
}

#[tauri::command]
pub async fn storage_read(
    session_id: String,
    account_id: String,
    path: String,
    sessions: Sessions<'_>,
) -> Result<Vec<u8>, String> {
    ops::read_small(&sessions.op(&session_id, &account_id)?, &path, READ_MAX).await
}

#[tauri::command]
pub async fn storage_write(
    session_id: String,
    account_id: String,
    path: String,
    data: Vec<u8>,
    sessions: Sessions<'_>,
) -> Result<(), String> {
    ops::write_small(&sessions.op(&session_id, &account_id)?, &path, data).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto, db};
    use serde_json::json;

    #[test]
    fn operator_from_store_uses_the_saved_account_and_job_bucket() {
        let mut keys = crypto::KeySession::new();
        crypto::generate_account_material(&mut keys).unwrap();
        let db = db::open(":memory:").unwrap();
        let crypto = CryptoState {
            session: Mutex::new(keys),
        };
        let missing = StorageRef {
            account_id: "gone".into(),
            bucket: "b".into(),
        };
        assert_eq!(
            operator_from_store(&db, &crypto, &missing).unwrap_err(),
            "storage account not found"
        );
        let row = super::super::accounts::save(
            &db,
            &crypto,
            None,
            "v1",
            "Backups",
            &json!({"provider": "aws", "region": "us-east-1", "bucket": "first",
                    "accessKeyId": "AKIA", "secretAccessKey": "secret-value-xyz"}),
            "6f1c1b2e-6b7a-4c1e-9a65-1f2a3b4c5d6e",
        )
        .unwrap();
        let r = StorageRef {
            account_id: row.id,
            bucket: "queued-bucket".into(),
        };
        assert_eq!(
            operator_from_store(&db, &crypto, &r).unwrap().info().name(),
            "queued-bucket"
        );
    }

    #[test]
    fn sessions_open_and_forget() {
        let s = StorageSessions::default();
        let op = Operator::new(opendal::services::Memory::default()).unwrap();
        let r = StorageRef {
            account_id: "a".into(),
            bucket: "b".into(),
        };
        assert!(s.insert_if(s.generation(), "pane-1".into(), r.clone(), op));
        assert_eq!(s.get("pane-1").map(|(seen, _)| seen), Some(r));
        s.clear();
        assert!(s.get("pane-1").is_none());
        assert!(s.op("pane-1", "a").is_err());
    }

    #[test]
    fn a_connect_from_before_sign_out_is_not_kept() {
        let s = StorageSessions::default();
        let op = || Operator::new(opendal::services::Memory::default()).unwrap();
        let r = StorageRef {
            account_id: "a".into(),
            bucket: "b".into(),
        };
        let started = s.generation();
        s.clear();
        assert!(!s.insert_if(started, "pane-1".into(), r.clone(), op()));
        assert!(s.get("pane-1").is_none());
        let started = s.generation();
        assert!(s.insert_if(started, "pane-1".into(), r, op()));
        assert!(s.get("pane-1").is_some());
    }

    #[test]
    fn a_call_for_one_account_never_reaches_another() {
        let s = StorageSessions::default();
        let op = Operator::new(opendal::services::Memory::default()).unwrap();
        let r = StorageRef {
            account_id: "bucket-b".into(),
            bucket: "b".into(),
        };
        // The pane reconnected to bucket-b while a call for bucket-a was in flight.
        assert!(s.insert_if(s.generation(), "pane-1".into(), r, op));
        assert!(s.op("pane-1", "bucket-a").is_err());
        assert!(s.op("pane-1", "bucket-b").is_ok());
    }
}
