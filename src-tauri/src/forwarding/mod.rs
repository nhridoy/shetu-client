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
    db: tauri::State<'_, crate::db::LocalDb>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<Vec<ForwardView>, String> {
    storage::list(&db, &host_id)
        .map(|items| items.into_iter().map(|item| view(item, &state)).collect())
}

#[tauri::command]
pub fn create_port_forward(
    input: ForwardInput,
    db: tauri::State<'_, crate::db::LocalDb>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    storage::create(&db, input).map(|item| view(item, &state))
}

#[tauri::command]
pub fn update_port_forward(
    id: String,
    input: ForwardInput,
    db: tauri::State<'_, crate::db::LocalDb>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    model::validate(&input)?;
    let old = storage::get(&db, &id)?;
    if old.host_id != input.host_id {
        return Err("Cannot move a port forward to a different host".into());
    }
    state.stop(&id);
    storage::update(&db, &id, input).map(|item| view(item, &state))
}

#[tauri::command]
pub fn delete_port_forward(
    id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<(), String> {
    state.stop(&id);
    storage::delete(&db, &id)
}

#[tauri::command]
pub async fn start_port_forward(
    id: String,
    owner_pane_id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    ssh: tauri::State<'_, crate::ssh::SshSessions>,
    state: tauri::State<'_, ForwardingState>,
    app: tauri::AppHandle,
) -> Result<ForwardView, String> {
    if owner_pane_id.trim().is_empty() {
        return Err("An owning terminal pane is required".into());
    }
    let definition = storage::get(&db, &id)?;
    state
        .start(definition.clone(), owner_pane_id, &db, &crypto, &app, &ssh)
        .await?;
    Ok(view(definition, &state))
}

#[tauri::command]
pub fn stop_port_forward(
    id: String,
    db: tauri::State<'_, crate::db::LocalDb>,
    state: tauri::State<'_, ForwardingState>,
) -> Result<ForwardView, String> {
    let definition = storage::get(&db, &id)?;
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
