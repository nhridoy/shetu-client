//! Open bucket panes (pane id → operator) and the commands a bucket pane uses.

use super::accounts::{check_account_access, load_account, remote_for};
use super::ops::{self, StorageEntry};
use super::Remote;
use crate::db::LocalDb;
use crate::transfers::model::StorageRef;
use crate::CryptoState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// Largest object `storage_read` opens in the app.
const READ_MAX: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct StorageSessions {
    open: Mutex<Panes>,
    /// The last attempt number handed out (by `begin`).
    attempts: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct Panes {
    sessions: HashMap<String, (StorageRef, Remote)>,
    /// Each pane's latest connect attempt; only it may store the pane's session.
    latest: HashMap<String, u64>,
}

/// A saved account's storage side, built from the encrypted store.
pub fn operator_from_store(
    db: &LocalDb,
    crypto: &CryptoState,
    r: &StorageRef,
) -> Result<Remote, String> {
    let mut account = load_account(db, crypto, &r.account_id)?;
    account.bucket = r.bucket.clone();
    remote_for(&account)
}

impl StorageSessions {
    pub fn get(&self, sid: &str) -> Option<(StorageRef, Remote)> {
        self.open.lock().ok()?.sessions.get(sid).cloned()
    }

    /// Starts a connect for the pane: its ticket, which supersedes the pane's earlier ones.
    pub fn begin(&self, sid: &str) -> u64 {
        let attempt = self
            .attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if let Ok(mut open) = self.open.lock() {
            open.latest.insert(sid.to_string(), attempt);
        }
        attempt
    }

    /// Stores a session only for the pane's latest attempt: a connect superseded by a newer
    /// one, or still in flight at disconnect or sign-out, can't replace or reopen the pane.
    pub fn insert_if(&self, attempt: u64, sid: String, r: StorageRef, op: Remote) -> bool {
        let Ok(mut open) = self.open.lock() else {
            return false;
        };
        if open.latest.get(&sid) != Some(&attempt) {
            return false;
        }
        open.sessions.insert(sid, (r, op));
        true
    }

    /// Disconnect: the session goes, and so does every connect still running for the pane.
    pub fn remove(&self, sid: &str) {
        if let Ok(mut open) = self.open.lock() {
            open.sessions.remove(sid);
            open.latest.remove(sid);
        }
    }

    /// Sign-out: every open bucket and every connect in flight is forgotten.
    pub fn clear(&self) {
        if let Ok(mut open) = self.open.lock() {
            open.sessions.clear();
            open.latest.clear();
        }
    }

    /// An operator for a transfer end: an open pane's on that bucket, else a new one.
    pub fn remote_for_ref(&self, app: &tauri::AppHandle, r: &StorageRef) -> Result<Remote, String> {
        let open = self.open.lock().ok().and_then(|o| {
            o.sessions
                .values()
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
    fn op(&self, sid: &str, account_id: &str) -> Result<opendal::Operator, String> {
        self.remote(sid, account_id).map(|r| r.op)
    }

    /// The pane's storage side, only if the pane still shows `account_id`.
    fn remote(&self, sid: &str, account_id: &str) -> Result<Remote, String> {
        match self.get(sid) {
            Some((r, remote)) if r.account_id == account_id => Ok(remote),
            Some(_) => Err("The pane now shows another bucket".to_string()),
            None => Err("Bucket not open — reconnect the pane".to_string()),
        }
    }
}

type Sessions<'a> = tauri::State<'a, StorageSessions>;

/// Opens a pane on an account's storage after checking it can be listed. Returns the provider.
#[tauri::command]
pub async fn storage_connect(
    session_id: String,
    account_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    sessions: Sessions<'_>,
) -> Result<String, String> {
    let attempt = sessions.begin(&session_id);
    let account = load_account(&db, &crypto, &account_id)?;
    let op = remote_for(&account)?;
    check_account_access(&account, &op).await?;
    let provider = account.provider.clone();
    let r = StorageRef {
        account_id,
        bucket: account.bucket,
    };
    if !sessions.insert_if(attempt, session_id, r, op) {
        return Err("The pane was closed while connecting".into());
    }
    Ok(provider)
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
    let remote = sessions.remote(&session_id, &account_id)?;
    match &remote.dav {
        // A server move: one request, and never over an existing name (OpenDAL's overwrites).
        Some(dav) => super::webdav::move_path(dav, &from, &to, is_dir).await,
        None => ops::rename_tree(&remote.op, &from, &to, is_dir).await,
    }
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
            operator_from_store(&db, &crypto, &missing).err().unwrap(),
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
            operator_from_store(&db, &crypto, &r)
                .unwrap()
                .op
                .info()
                .name(),
            "queued-bucket"
        );
    }

    #[test]
    fn sessions_open_and_forget() {
        let s = StorageSessions::default();
        let op = Remote {
            op: opendal::Operator::new(opendal::services::Memory::default()).unwrap(),
            dav: None,
        };
        let r = StorageRef {
            account_id: "a".into(),
            bucket: "b".into(),
        };
        assert!(s.insert_if(s.begin("pane-1"), "pane-1".into(), r.clone(), op));
        assert_eq!(s.get("pane-1").map(|(seen, _)| seen), Some(r));
        s.clear();
        assert!(s.get("pane-1").is_none());
        assert!(s.op("pane-1", "a").is_err());
    }

    #[test]
    fn a_connect_from_before_sign_out_is_not_kept() {
        let s = StorageSessions::default();
        let op = || Remote {
            op: opendal::Operator::new(opendal::services::Memory::default()).unwrap(),
            dav: None,
        };
        let r = StorageRef {
            account_id: "a".into(),
            bucket: "b".into(),
        };
        let a = s.begin("pane-1");
        s.clear();
        assert!(!s.insert_if(a, "pane-1".into(), r.clone(), op()));
        assert!(s.get("pane-1").is_none());
        let b = s.begin("pane-1");
        assert!(s.insert_if(b, "pane-1".into(), r, op()));
        assert!(s.get("pane-1").is_some());
    }

    #[test]
    fn a_call_for_one_account_never_reaches_another() {
        let s = StorageSessions::default();
        let op = Remote {
            op: opendal::Operator::new(opendal::services::Memory::default()).unwrap(),
            dav: None,
        };
        let r = StorageRef {
            account_id: "bucket-b".into(),
            bucket: "b".into(),
        };
        // The pane reconnected to bucket-b while a call for bucket-a was in flight.
        assert!(s.insert_if(s.begin("pane-1"), "pane-1".into(), r, op));
        assert!(s.op("pane-1", "bucket-a").is_err());
        assert!(s.op("pane-1", "bucket-b").is_ok());
    }

    fn memory() -> Remote {
        Remote {
            op: opendal::Operator::new(opendal::services::Memory::default()).unwrap(),
            dav: None,
        }
    }

    fn account(id: &str) -> StorageRef {
        StorageRef {
            account_id: id.into(),
            bucket: "b".into(),
        }
    }

    #[test]
    fn a_connect_after_its_pane_closed_is_not_kept() {
        let s = StorageSessions::default();
        let a = s.begin("pane-1");
        s.remove("pane-1");
        assert!(!s.insert_if(a, "pane-1".into(), account("a"), memory()));
        assert!(s.get("pane-1").is_none());
    }

    #[test]
    fn an_older_connect_never_replaces_a_newer_one() {
        let s = StorageSessions::default();
        let a = s.begin("pane-1");
        let b = s.begin("pane-1");
        assert!(s.insert_if(b, "pane-1".into(), account("b"), memory()));
        assert!(!s.insert_if(a, "pane-1".into(), account("a"), memory()));
        assert_eq!(s.get("pane-1").unwrap().0.account_id, "b");
    }

    #[test]
    fn tickets_are_per_pane() {
        let s = StorageSessions::default();
        let a = s.begin("pane-1");
        let b = s.begin("pane-2");
        s.remove("pane-2");
        assert!(s.insert_if(a, "pane-1".into(), account("a"), memory()));
        assert!(!s.insert_if(b, "pane-2".into(), account("b"), memory()));
    }
}
