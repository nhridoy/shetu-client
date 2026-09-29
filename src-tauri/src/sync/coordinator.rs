use crate::db::sync_db::{
    ack_push_results, adopt_pending_device, apply_pull_page, is_cancelled_vault, last_sync_at,
    mark_sync_complete, pending_batch, pending_count, pull_cursor, validate_pull_payloads,
    PullChange, PushResult,
};
use crate::db::LocalDb;
use crate::http::{HttpClient, HttpErrorKind};
use crate::CryptoState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

const PAGE_SIZE: usize = 100;
const MAX_PULL_PAGES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncReport {
    pub pending: usize,
    pub last_sync_at: Option<String>,
    pub cursor: u64,
}

#[derive(Default)]
pub struct SyncLocks(Mutex<HashMap<String, Arc<Mutex<()>>>>);

impl SyncLocks {
    pub async fn for_vault(&self, vault_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.0.lock().await;
        map.entry(vault_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[derive(Deserialize)]
struct PullReply {
    changes: Vec<PullChange>,
    next_cursor: u64,
    has_more: bool,
}

#[derive(Deserialize)]
struct PushReply {
    results: Vec<PushResult>,
}

fn local_error(message: String) -> HttpErrorKind {
    HttpErrorKind::Http(0, message)
}

async fn pull_until_caught_up(
    vault_id: &str,
    db: &LocalDb,
    crypto: &CryptoState,
    http: &HttpClient,
) -> Result<(), HttpErrorKind> {
    for _ in 0..MAX_PULL_PAGES {
        let cursor = pull_cursor(db, vault_id).map_err(local_error)?;
        let response = http
            .request(
                "POST",
                "/api/v1/sync/pull",
                Some(json!({
                    "vault_id": vault_id,
                    "after_cursor": cursor,
                    "limit": PAGE_SIZE,
                })),
                true,
            )
            .await?;
        let page: PullReply = serde_json::from_str(&response.body)
            .map_err(|_| local_error("invalid sync pull response".into()))?;
        {
            let session = crypto
                .session
                .lock()
                .map_err(|e| local_error(e.to_string()))?;
            validate_pull_payloads(&page.changes, &session).map_err(local_error)?;
        }
        apply_pull_page(db, vault_id, &page.changes, page.next_cursor).map_err(local_error)?;
        if !page.has_more {
            return Ok(());
        }
        if page.next_cursor <= cursor {
            return Err(local_error("sync pull cursor did not advance".into()));
        }
    }
    Err(local_error(
        "sync pull page limit reached; retry to continue".into(),
    ))
}

pub async fn run_sync_cycle(
    vault_id: &str,
    device_id: &str,
    db: &LocalDb,
    crypto: &CryptoState,
    http: &HttpClient,
) -> Result<SyncReport, HttpErrorKind> {
    adopt_pending_device(db, device_id).map_err(local_error)?;
    if is_cancelled_vault(db, vault_id).map_err(local_error)? {
        return Ok(SyncReport {
            pending: 0,
            last_sync_at: last_sync_at(db, vault_id).map_err(local_error)?,
            cursor: pull_cursor(db, vault_id).map_err(local_error)?,
        });
    }
    // A vault created offline does not exist on the server yet, so its first
    // pull would be forbidden. Publish its vault row before pulling children.
    if pull_cursor(db, vault_id).map_err(local_error)? == 0 {
        let first = pending_batch(db, vault_id, 1).map_err(local_error)?;
        if first
            .first()
            .is_some_and(|op| op.table == "vaults" && op.record["deleted_at"].is_null())
        {
            let response = http
                .request(
                    "POST",
                    "/api/v1/sync/push",
                    Some(json!({
                        "vault_id": vault_id,
                        "device_id": device_id,
                        "operations": first,
                    })),
                    true,
                )
                .await?;
            let reply: PushReply = serde_json::from_str(&response.body)
                .map_err(|_| local_error("invalid sync push response".into()))?;
            ack_push_results(db, vault_id, &reply.results).map_err(local_error)?;
        }
    }
    pull_until_caught_up(vault_id, db, crypto, http).await?;
    let pending = pending_batch(db, vault_id, PAGE_SIZE).map_err(local_error)?;
    if !pending.is_empty() {
        let response = http
            .request(
                "POST",
                "/api/v1/sync/push",
                Some(json!({
                    "vault_id": vault_id,
                    "device_id": device_id,
                    "operations": pending,
                })),
                true,
            )
            .await?;
        let reply: PushReply = serde_json::from_str(&response.body)
            .map_err(|_| local_error("invalid sync push response".into()))?;
        ack_push_results(db, vault_id, &reply.results).map_err(local_error)?;
    }
    pull_until_caught_up(vault_id, db, crypto, http).await?;
    mark_sync_complete(db, vault_id).map_err(local_error)?;
    Ok(SyncReport {
        pending: pending_count(db, vault_id).map_err(local_error)?,
        last_sync_at: last_sync_at(db, vault_id).map_err(local_error)?,
        cursor: pull_cursor(db, vault_id).map_err(local_error)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn sync_same_vault_serializes_but_other_vault_can_run() {
        let locks = SyncLocks::default();
        let a = locks.for_vault("vault-a").await;
        let same = locks.for_vault("vault-a").await;
        let b = locks.for_vault("vault-b").await;
        assert!(Arc::ptr_eq(&a, &same));
        let held = a.lock().await;
        assert!(tokio::time::timeout(Duration::from_millis(10), same.lock())
            .await
            .is_err());
        assert!(tokio::time::timeout(Duration::from_millis(10), b.lock())
            .await
            .is_ok());
        drop(held);
        assert!(tokio::time::timeout(Duration::from_millis(10), same.lock())
            .await
            .is_ok());
    }
}

#[cfg(test)]
mod cycle_tests {
    use super::*;
    use crate::db::{self, SyncRow, Table};
    use crate::http::{HttpState, RefreshProvider};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    struct NoRefresh;
    impl RefreshProvider for NoRefresh {
        fn get_refresh_token(&self) -> Option<String> {
            None
        }
        fn persist_rotated_token(&self, _: &str) {}
        fn clear(&self) {}
    }

    fn unlocked_crypto() -> CryptoState {
        let mut session = crate::crypto::KeySession::new();
        crate::crypto::generate_account_material(&mut session).unwrap();
        CryptoState {
            session: std::sync::Mutex::new(session),
        }
    }

    fn ciphertext(crypto: &CryptoState) -> String {
        let session = crypto.session.lock().unwrap();
        crate::crypto::encrypt_secret("{}", "hosts", &session).unwrap()
    }

    fn fake_server(replies: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for body in replies {
                let (mut socket, _) = listener.accept().unwrap();
                let mut received = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    received.extend_from_slice(&buffer[..n]);
                    if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&received[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if received.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, worker)
    }

    #[tokio::test]
    async fn sync_cycle_pulls_pushes_acks_and_pulls_again() {
        let db = db::open(":memory:").unwrap();
        let crypto = unlocked_crypto();
        let vault = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let row = db::local_mutate(
            &db,
            Table::Hosts,
            &SyncRow {
                id,
                vault_id: vault.clone(),
                name: Some("Office".into()),
                data: ciphertext(&crypto),
                ..Default::default()
            },
            &device,
        )
        .unwrap();
        let record = pending_batch(&db, &vault, 1).unwrap()[0].record.clone();
        let first_pull =
            json!({"changes":[],"next_cursor":0,"upper_cursor":0,"has_more":false}).to_string();
        let push = json!({"results":[{"operation_id":row.operation_id,"fate":"accepted","canonical_record":record.clone(),"cursor":1}]}).to_string();
        let last_pull = json!({"changes":[{"cursor":1,"table":"hosts","record":record}],"next_cursor":1,"upper_cursor":1,"has_more":false}).to_string();
        let (url, worker) = fake_server(vec![first_pull, push, last_pull]);
        let state = HttpState::new(url);
        state.set_token(Some("access".into()));
        let http = HttpClient::new(state, Arc::new(NoRefresh));
        let report = run_sync_cycle(&vault, &device, &db, &crypto, &http)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(report.pending, 0);
        assert_eq!(report.cursor, 1);
        assert!(report.last_sync_at.is_some());
        assert!(pending_batch(&db, &vault, 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn first_sync_publishes_offline_vault_before_pull() {
        let db = db::open(":memory:").unwrap();
        let crypto = unlocked_crypto();
        let vault = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        let row = db::local_mutate(
            &db,
            Table::Vaults,
            &SyncRow {
                id: vault.clone(),
                owner_id: Some(uuid::Uuid::new_v4().to_string()),
                name: Some("Offline vault".into()),
                kind: Some("custom".into()),
                data: "{}".into(),
                ..Default::default()
            },
            &device,
        )
        .unwrap();
        let record = pending_batch(&db, &vault, 1).unwrap()[0].record.clone();
        let push = json!({"results":[{"operation_id":row.operation_id,"fate":"accepted","canonical_record":record.clone(),"cursor":1}]}).to_string();
        let pull = json!({"changes":[{"cursor":1,"table":"vaults","record":record}],"next_cursor":1,"upper_cursor":1,"has_more":false}).to_string();
        let empty =
            json!({"changes":[],"next_cursor":1,"upper_cursor":1,"has_more":false}).to_string();
        let (url, worker) = fake_server(vec![push, pull, empty]);
        let state = HttpState::new(url);
        state.set_token(Some("access".into()));
        let http = HttpClient::new(state, Arc::new(NoRefresh));
        let report = run_sync_cycle(&vault, &device, &db, &crypto, &http)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(report.pending, 0);
        assert_eq!(report.cursor, 1);
    }

    #[tokio::test]
    async fn network_error_keeps_pending_operation() {
        let db = db::open(":memory:").unwrap();
        let crypto = unlocked_crypto();
        let vault = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        db::local_mutate(
            &db,
            Table::Hosts,
            &SyncRow {
                id: uuid::Uuid::new_v4().to_string(),
                vault_id: vault.clone(),
                name: Some("Offline".into()),
                data: ciphertext(&crypto),
                ..Default::default()
            },
            &device,
        )
        .unwrap();
        let state = HttpState::new("http://127.0.0.1:1".into());
        state.set_token(Some("access".into()));
        let http = HttpClient::new(state, Arc::new(NoRefresh));
        assert_eq!(
            run_sync_cycle(&vault, &device, &db, &crypto, &http)
                .await
                .unwrap_err(),
            HttpErrorKind::Network
        );
        assert_eq!(pending_batch(&db, &vault, 10).unwrap().len(), 1);
    }
}
