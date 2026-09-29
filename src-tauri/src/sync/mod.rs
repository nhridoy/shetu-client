mod coordinator;

pub use coordinator::{run_sync_cycle, SyncLocks, SyncReport};

use crate::db::LocalDb;
use crate::http::{HttpClient, HttpErrorKind, HttpState, KeyringRefreshProvider};
use crate::CryptoState;
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    vault_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    http: tauri::State<'_, HttpState>,
    locks: tauri::State<'_, SyncLocks>,
    device_id: String,
) -> Result<SyncReport, String> {
    if uuid::Uuid::parse_str(&device_id).is_err() {
        return Err("sync:invalid-device-id".into());
    }
    if uuid::Uuid::parse_str(&vault_id).is_err() {
        return Err("sync:invalid-vault-id".into());
    }
    let lock = locks.for_vault(&vault_id).await;
    let _guard = lock.lock().await;
    {
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        crate::forwarding::storage::migrate_legacy(&db, &session, &device_id)?;
    }
    let client = HttpClient::new(
        http.inner().clone(),
        Arc::new(KeyringRefreshProvider { app: app.clone() }),
    );
    run_sync_cycle(&vault_id, &device_id, &db, &crypto, &client)
        .await
        .map_err(|err| match err {
            HttpErrorKind::Network => "network:Cannot reach the sync server".into(),
            HttpErrorKind::SessionExpired => "auth:Sign in again to sync pending changes".into(),
            HttpErrorKind::Http(0, message) => format!("sync:{message}"),
            HttpErrorKind::Http(status, _) if status == 401 => {
                "auth:Sign in again to sync pending changes".into()
            }
            HttpErrorKind::Http(status, _) => format!("sync:server-error-{status}"),
        })
}
