pub mod model;
pub mod relay;
pub mod runtime;
pub mod socks;
pub mod storage;

use model::{ForwardDefinition, ForwardInput, ForwardStatus};
use runtime::ForwardingState;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    pub definition: ForwardDefinition,
    pub status: ForwardStatus,
}

fn view(definition: ForwardDefinition, state: &ForwardingState) -> ForwardView {
    let status = state.status(&definition.id);
    ForwardView { definition, status }
}

#[tauri::command]
pub fn list_port_forwards(
    host_id: String,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<Vec<ForwardView>, String> {
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    storage::list(&db, &session, &device_id, &host_id)
        .map(|items| items.into_iter().map(|item| view(item, &state)).collect())
}

#[tauri::command]
pub fn create_port_forward(
    input: ForwardInput,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    storage::create(&db, &session, &device_id, input).map(|item| view(item, &state))
}

#[tauri::command]
pub fn update_port_forward(
    id: String,
    input: ForwardInput,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    model::validate(&input)?;
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    let old = storage::get(&db, &session, &device_id, &id)?;
    if old.host_id != input.host_id {
        return Err("Cannot move a port forward to a different host".into());
    }
    state.stop(&id);
    storage::update(&db, &session, &device_id, &id, input).map(|item| view(item, &state))
}

#[tauri::command]
pub fn delete_port_forward(
    id: String,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<(), String> {
    state.stop(&id);
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    storage::delete(&db, &session, &device_id, &id)
}

#[tauri::command]
pub async fn start_port_forward(
    id: String,
    owner_pane_id: String,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    ssh: tauri::State<'_, crate::ssh::SshSessions>,
    state: tauri::State<'_, ForwardingState>,
    app: tauri::AppHandle,
) -> Result<ForwardView, String> {
    if owner_pane_id.trim().is_empty() {
        return Err("An owning terminal pane is required".into());
    }
    let definition = {
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        storage::get(&db, &session, &device_id, &id)?
    };
    state
        .start(definition.clone(), owner_pane_id, &db, &crypto, &app, &ssh)
        .await?;
    Ok(view(definition, &state))
}

/// Owner of forwards started on unlock: no pane, they run until stopped or logout.
pub const APP_OWNER: &str = "app";

/// Starts the forwards set to auto-start for `trigger` ("unlock", or "terminal" with the
/// host and its pane). Forwards already up are left alone; one that fails to start shows
/// Failed like a manual start. Returns how many started.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn auto_start_forwards(
    trigger: String,
    host_id: Option<String>,
    owner_pane_id: Option<String>,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    ssh: tauri::State<'_, crate::ssh::SshSessions>,
    state: tauri::State<'_, ForwardingState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let (trigger, owner) = match (trigger.as_str(), host_id, owner_pane_id) {
        ("unlock", _, _) => (storage::Trigger::Unlock, APP_OWNER.to_string()),
        ("terminal", Some(host), Some(pane)) if !pane.trim().is_empty() => {
            (storage::Trigger::Terminal(host), pane)
        }
        _ => return Err("Unknown auto-start trigger".into()),
    };
    let candidates = {
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        storage::auto_start_candidates(&db, &session, &trigger)?
    };
    let mut started = 0;
    for definition in candidates {
        if !runtime::should_auto_start(&state.status(&definition.id)) {
            continue;
        }
        if state
            .start(definition, owner.clone(), &db, &crypto, &app, &ssh)
            .await
            .is_ok()
        {
            started += 1;
        }
    }
    Ok(started)
}

#[tauri::command]
pub fn stop_port_forward(
    id: String,
    device_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    let definition = storage::get(&db, &session, &device_id, &id)?;
    state.stop(&id);
    Ok(view(definition, &state))
}

#[tauri::command]
pub fn stop_port_forwards_for_owner(
    owner_pane_id: String,
    state: tauri::State<'_, ForwardingState>,
) {
    state.stop_owner(&owner_pane_id);
}
