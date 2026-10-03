#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crypto;
mod db;
mod session_history;
mod forwarding;
mod git;
mod http;
mod keys;
mod oauth;
mod offline_auth;
mod sftp;
mod ssh;
mod ssh_route;
mod sync;
mod team_keys;
mod update;

use base64::{engine::general_purpose::STANDARD_NO_PAD as BASE64, Engine};
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, PtyPair, PtySize,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, Listener, Manager};
#[cfg(target_os = "windows")]
use tauri_plugin_prevent_default::PlatformOptions;

pub struct AppState {
    pub device_id: String,
    pub api_url: Mutex<Option<String>>,
}

pub struct CancelTokens {
    pub tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
pub struct HistoryRecorderState {
    buffers: Mutex<HashMap<String, session_history::OutputBuffer>>,
    active: Mutex<std::collections::HashSet<String>>,
}

#[tauri::command]
fn history_start_attempt(
    vault_id: String,
    attempt_id: String,
    host_id: String,
    host_label: String,
    connection_type: String,
    recording: bool,
    db: tauri::State<'_, db::LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    app: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, HistoryRecorderState>,
) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::start_attempt(&db, &keys, &app.device_id, &vault_id, &attempt_id, &host_id, &host_label, &connection_type, recording)?;
    if recording {
        recorder.buffers.lock().map_err(|e| e.to_string())?.insert(attempt_id.clone(), session_history::OutputBuffer::default());
    }
    recorder.active.lock().map_err(|e| e.to_string())?.insert(attempt_id);
    Ok(())
}

#[tauri::command]
fn history_mark_connected(attempt_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::mark_connected(&db, &keys, &app.device_id, &attempt_id)
}

#[tauri::command]
fn history_append_output(attempt_id: String, output: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>, recorder: tauri::State<'_, HistoryRecorderState>) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    let mut buffers = recorder.buffers.lock().map_err(|e| e.to_string())?;
    if let Some(buffer) = buffers.get_mut(&attempt_id) {
        session_history::append_output(&db, &keys, &app.device_id, &attempt_id, buffer, &output)?;
    }
    Ok(())
}

#[tauri::command]
fn history_flush_output(attempt_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>, recorder: tauri::State<'_, HistoryRecorderState>) -> Result<bool, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    let mut buffers = recorder.buffers.lock().map_err(|e| e.to_string())?;
    if let Some(buffer) = buffers.get_mut(&attempt_id) {
        return session_history::flush_output(&db, &keys, &app.device_id, &attempt_id, buffer);
    }
    Ok(false)
}

#[tauri::command]
fn history_finish_attempt(attempt_id: String, outcome: String, reason: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>, recorder: tauri::State<'_, HistoryRecorderState>) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    {
        let mut buffers = recorder.buffers.lock().map_err(|e| e.to_string())?;
        if let Some(buffer) = buffers.get_mut(&attempt_id) {
            session_history::flush_output(&db, &keys, &app.device_id, &attempt_id, buffer)?;
        }
    }
    session_history::finish_attempt(&db, &keys, &app.device_id, &attempt_id, &outcome, &reason)?;
    recorder.buffers.lock().map_err(|e| e.to_string())?.remove(&attempt_id);
    recorder.active.lock().map_err(|e| e.to_string())?.remove(&attempt_id);
    Ok(())
}

#[tauri::command]
fn history_list(vault_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>) -> Result<Vec<session_history::HistoryItem>, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::reconcile_deleted_chunks(&db, &keys, &app.device_id, &vault_id)?;
    session_history::list_attempts(&db, &keys, &vault_id)
}

#[tauri::command]
fn history_recover_interrupted(vault_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>, recorder: tauri::State<'_, HistoryRecorderState>) -> Result<usize, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    let active = recorder.active.lock().map_err(|e| e.to_string())?.iter().cloned().collect::<Vec<_>>();
    session_history::recover_interrupted(&db, &keys, &app.device_id, &vault_id, &active)
}

#[tauri::command]
fn history_get_output(vault_id: String, attempt_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::read_output(&db, &keys, &vault_id, &attempt_id)
}

#[tauri::command]
fn history_delete(vault_id: String, attempt_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::delete_attempt(&db, &keys, &app.device_id, &vault_id, &attempt_id)
}

#[tauri::command]
fn history_get_retention(vault_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>) -> Result<u32, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::get_retention_days(&db, &keys, &vault_id)
}

#[tauri::command]
fn history_set_retention(vault_id: String, days: u32, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>) -> Result<(), String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    session_history::set_retention_days(&db, &keys, &app.device_id, &vault_id, days)
}

#[tauri::command]
fn history_apply_retention(vault_id: String, db: tauri::State<'_, db::LocalDb>, crypto: tauri::State<'_, CryptoState>, app: tauri::State<'_, AppState>) -> Result<usize, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    let expired = session_history::apply_retention(&db, &keys, &app.device_id, &vault_id)?;
    let orphaned = session_history::reconcile_deleted_chunks(&db, &keys, &app.device_id, &vault_id)?;
    Ok(expired + orphaned)
}

#[tauri::command]
fn get_device_id(state: tauri::State<'_, AppState>) -> String {
    state.device_id.clone()
}

#[tauri::command]
fn set_api_url(url: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.api_url.lock().map_err(|e| e.to_string())?;
    *guard = Some(url);
    Ok(())
}

#[tauri::command]
fn get_api_url(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.api_url.lock().map_err(|e| e.to_string())?;
    Ok(guard
        .clone()
        .unwrap_or_else(|| "http://localhost:8080".to_string()))
}

#[tauri::command]
fn wipe_local_data(
    db: tauri::State<'_, db::LocalDb>,
    forwarding: tauri::State<'_, forwarding::runtime::ForwardingState>,
) -> Result<(), String> {
    forwarding.stop_all();
    db::wipe_all(&db)
}

#[tauri::command]
fn db_upsert(
    db: tauri::State<'_, db::LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    table: String,
    row: serde_json::Value,
    plaintext: Option<String>,
    record_type: Option<String>,
    device_id: String,
) -> Result<db::SyncRow, String> {
    let table = db::Table::parse(&table)?;
    let mut row: db::SyncRow =
        serde_json::from_value(row).map_err(|e| format!("db_upsert: bad row: {e}"))?;
    if let Some(plaintext) = plaintext {
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        let rt = record_type.as_deref().unwrap_or(table.as_str());
        row.data = team_keys::encrypt_row_secret(&db, &session, &plaintext, rt, &row.vault_id)?;
    }
    db::local_mutate(&db, table, &row, &device_id)
}

#[tauri::command]
fn db_get(
    db: tauri::State<'_, db::LocalDb>,
    table: String,
    id: String,
) -> Result<Option<db::SyncRow>, String> {
    let table = db::Table::parse(&table)?;
    db::get_sync_row(&db, table, &id)
}

#[tauri::command]
fn db_list(
    db: tauri::State<'_, db::LocalDb>,
    table: String,
    vault_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<db::SyncRow>, String> {
    let table = db::Table::parse(&table)?;
    db::list_sync_rows(&db, table, &vault_id, include_deleted.unwrap_or(false))
}

#[tauri::command]
fn db_delete(
    db: tauri::State<'_, db::LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
    forwarding: tauri::State<'_, forwarding::runtime::ForwardingState>,
    table: String,
    id: String,
    device_id: String,
) -> Result<(), String> {
    let table = db::Table::parse(&table)?;
    if table == db::Table::Vaults {
        {
            let session = crypto.session.lock().map_err(|e| e.to_string())?;
            forwarding::storage::migrate_legacy(&db, &session, &device_id)?;
        }
        for host in db::list_sync_rows(&db, db::Table::Hosts, &id, false)? {
            forwarding.stop_host(&host.id);
        }
        return db::tombstone_vault_with_descendants(&db, &id, &device_id);
    }
    if table == db::Table::Hosts {
        forwarding.stop_host(&id);
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        forwarding::storage::migrate_legacy(&db, &session, &device_id)?;
        forwarding::storage::delete_for_host(&db, &id, &device_id)?;
    }
    db::tombstone_sync_row_with_device(&db, table, &id, &device_id)?;
    Ok(())
}

#[tauri::command]
fn db_outbox(db: tauri::State<'_, db::LocalDb>) -> Result<Vec<db::OutboxEntry>, String> {
    db::outbox_pending(&db)
}

#[derive(serde::Deserialize)]
struct SortOrderUpdate {
    id: String,
    sort_order: i64,
}

#[tauri::command]
fn db_update_sort_orders(
    db: tauri::State<'_, db::LocalDb>,
    table: String,
    updates: Vec<SortOrderUpdate>,
    device_id: String,
) -> Result<(), String> {
    let table = db::Table::parse(&table)?;
    let pairs: Vec<(String, i64)> = updates.into_iter().map(|u| (u.id, u.sort_order)).collect();
    db::update_sort_orders_with_device(&db, table, &pairs, &device_id)
}

#[tauri::command]
fn db_update_host_group(
    db: tauri::State<'_, db::LocalDb>,
    host_id: String,
    group_id: String,
    device_id: String,
) -> Result<(), String> {
    db::update_host_group_with_device(&db, &host_id, &group_id, &device_id)
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, contents).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ShellInfo {
    name: String,
    path: String,
}

fn probe_shell(name: &str, args: &[&str]) -> Option<ShellInfo> {
    std::process::Command::new(name)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(ShellInfo {
                    name: name.to_string(),
                    path: name.to_string(),
                })
            } else {
                None
            }
        })
}

fn probe_shell_with_timeout(name: &str, args: &[&str], timeout_ms: u64) -> Option<ShellInfo> {
    use std::process::Command;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let mut cmd = Command::new(name);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let child_id;

    {
        let child = cmd.spawn().ok()?;
        child_id = child.id();

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(timeout_ms));
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/PID", &child_id.to_string()])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = Command::new("kill")
                    .args(["-9", &child_id.to_string()])
                    .output();
            }
            let _ = tx.send(());
        });

        let output = child.wait_with_output().ok()?;
        let _ = rx.recv_timeout(Duration::from_millis(100));

        if output.status.success() {
            return Some(ShellInfo {
                name: name.to_string(),
                path: name.to_string(),
            });
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn detect_shells_platform() -> Vec<ShellInfo> {
    let mut shells = Vec::new();

    // PowerShell 7+ (pwsh)
    if let Some(s) = probe_shell("pwsh", &["--version"]) {
        shells.push(ShellInfo {
            name: "PowerShell 7".to_string(),
            ..s
        });
    }
    // Windows PowerShell
    if let Some(s) = probe_shell("powershell.exe", &["-NoProfile", "-Command", "echo ok"]) {
        shells.push(ShellInfo {
            name: "PowerShell".to_string(),
            ..s
        });
    }
    // cmd.exe
    if probe_shell("cmd.exe", &["/C", "echo ok"]).is_some() {
        shells.push(ShellInfo {
            name: "Command Prompt".to_string(),
            path: "cmd.exe".to_string(),
        });
    }
    // Git Bash
    let git_bash_paths = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for p in &git_bash_paths {
        if std::path::Path::new(p).exists() {
            shells.push(ShellInfo {
                name: "Git Bash".to_string(),
                path: p.to_string(),
            });
            break;
        }
    }
    // WSL — use timeout probe to avoid hanging on misconfigured systems
    if probe_shell_with_timeout("wsl.exe", &["--status"], 3000).is_some() {
        shells.push(ShellInfo {
            name: "WSL".to_string(),
            path: "wsl.exe".to_string(),
        });
    }
    // sh (if available via MSYS/Git/etc) — use -c "echo ok" since most
    // Windows sh implementations don't support --version
    if probe_shell("sh", &["-c", "echo ok"]).is_some() {
        shells.push(ShellInfo {
            name: "sh".to_string(),
            path: "sh".to_string(),
        });
    }

    shells
}

#[cfg(target_os = "macos")]
fn detect_shells_platform() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Respect user's default shell
    if let Ok(user_shell) = std::env::var("SHELL") {
        let shell_name = user_shell.split('/').last().unwrap_or("shell").to_string();
        shells.push(ShellInfo {
            name: format!("{shell_name} (default)"),
            path: user_shell,
        });
        seen_names.insert(shell_name);
    }

    // Common shells — dedup by base name to avoid duplicates when $SHELL
    // points to a non-standard path (e.g. /usr/local/bin/zsh)
    let candidates = [
        ("/bin/zsh", "zsh"),
        ("/bin/bash", "bash"),
        ("/usr/bin/fish", "fish"),
        ("/opt/homebrew/bin/fish", "fish"),
        ("pwsh", "PowerShell 7"),
    ];

    for (path, display) in &candidates {
        if !seen_names.contains(*display) && probe_shell(path, &["-c", "echo ok"]).is_some() {
            shells.push(ShellInfo {
                name: display.to_string(),
                path: path.to_string(),
            });
            seen_names.insert(display.to_string());
        }
    }

    shells
}

#[cfg(target_os = "linux")]
fn detect_shells_platform() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Respect user's default shell
    if let Ok(user_shell) = std::env::var("SHELL") {
        let shell_name = user_shell.split('/').last().unwrap_or("shell").to_string();
        shells.push(ShellInfo {
            name: format!("{shell_name} (default)"),
            path: user_shell,
        });
        seen_names.insert(shell_name);
    }

    let candidates = [
        ("/bin/bash", "bash"),
        ("/usr/bin/bash", "bash"),
        ("/bin/zsh", "zsh"),
        ("/usr/bin/zsh", "zsh"),
        ("/usr/bin/fish", "fish"),
        ("pwsh", "PowerShell 7"),
    ];

    for (path, display) in &candidates {
        if !seen_names.contains(*display) && probe_shell(path, &["-c", "echo ok"]).is_some() {
            shells.push(ShellInfo {
                name: display.to_string(),
                path: path.to_string(),
            });
            seen_names.insert(display.to_string());
        }
    }

    shells
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn detect_shells_platform() -> Vec<ShellInfo> {
    vec![ShellInfo {
        name: "sh".to_string(),
        path: "sh".to_string(),
    }]
}

#[tauri::command]
async fn detect_shells() -> Vec<ShellInfo> {
    tokio::task::spawn_blocking(|| detect_shells_platform())
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_same_volume(path1: String, path2: String) -> Result<bool, String> {
    // Canonicalize both paths, then compare their root (e.g. "C:\")
    let canon1 = std::fs::canonicalize(&path1).map_err(|e| e.to_string())?;
    let canon2 = std::fs::canonicalize(&path2).map_err(|e| e.to_string())?;

    // Get the root directory of each path (e.g. C:\ or \\server\share)
    let root1 = canon1.ancestors().last().unwrap_or(&canon1);
    let root2 = canon2.ancestors().last().unwrap_or(&canon2);

    Ok(root1 == root2)
}

#[cfg(unix)]
#[tauri::command]
fn is_same_volume(path1: String, path2: String) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let meta1 = std::fs::metadata(&path1).map_err(|e| e.to_string())?;
    let meta2 = std::fs::metadata(&path2).map_err(|e| e.to_string())?;
    Ok(meta1.dev() == meta2.dev())
}

#[cfg(not(any(target_os = "windows", unix)))]
#[tauri::command]
fn is_same_volume(_path1: String, _path2: String) -> Result<bool, String> {
    Ok(false)
}

#[derive(serde::Deserialize)]
struct CopyFileEntry {
    source: String,
    destination: String,
}

#[tauri::command]
async fn get_file_size(path: String) -> Result<u64, String> {
    let p = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        p.metadata()
            .map(|m| m.len())
            .map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn is_directory(path: String) -> Result<bool, String> {
    let p = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        p.metadata()
            .map(|m| m.is_dir())
            .map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn fs_exists(path: String) -> Result<bool, String> {
    let p = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || Ok(p.exists()))
        .await
        .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn fs_mkdir(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&p).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn fs_remove(path: String, recursive: bool) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        // Inspect the link itself (no traversal): files and symlinks must be
        // removed with remove_file — remove_dir_all fails on Windows with
        // "The directory name is invalid" (os error 267) for anything that is
        // not a real directory.
        let meta = std::fs::symlink_metadata(&p).map_err(|e| format!("{path}: {e}"))?;
        if meta.is_file() || meta.file_type().is_symlink() {
            std::fs::remove_file(&p)
        } else if recursive {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_dir(&p)
        }
        .map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn fs_copy(source: String, dest: String) -> Result<(), String> {
    let src = std::path::PathBuf::from(&source);
    let dst = std::path::PathBuf::from(&dest);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{dest}: {e}"))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("{source} -> {dest}: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn fs_rename(source: String, dest: String) -> Result<(), String> {
    let src = std::path::PathBuf::from(&source);
    let dst = std::path::PathBuf::from(&dest);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::rename(&src, &dst).map_err(|e| format!("{source} -> {dest}: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
fn cancel_copy(state: tauri::State<'_, CancelTokens>, operation_id: String) -> Result<(), String> {
    let tokens = state.tokens.lock().map_err(|e| e.to_string())?;
    if let Some(token) = tokens.get(&operation_id) {
        token.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn copy_files_with_progress(
    app: tauri::AppHandle,
    state: tauri::State<'_, CancelTokens>,
    files: Vec<CopyFileEntry>,
    operation_id: String,
) -> Result<Vec<String>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .tokens
        .lock()
        .map_err(|e| e.to_string())?
        .insert(operation_id.clone(), cancelled.clone());

    let op_id = operation_id.clone();
    let errors = tauri::async_runtime::spawn_blocking(move || {
        let mut errors = Vec::new();
        for entry in &files {
            if cancelled.load(Ordering::Relaxed) {
                errors.push("Cancelled".to_string());
                break;
            }

            let src = std::path::Path::new(&entry.source);
            let dst = std::path::Path::new(&entry.destination);
            let name = src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| entry.source.clone());

            if let Some(parent) = dst.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    errors.push(format!("{name}: {e}"));
                    continue;
                }
            }

            let total = match std::fs::metadata(src) {
                Ok(m) => m.len(),
                Err(e) => {
                    errors.push(format!("{name}: {e}"));
                    continue;
                }
            };

            let src_file = match std::fs::File::open(src) {
                Ok(f) => f,
                Err(e) => {
                    errors.push(format!("{name}: {e}"));
                    continue;
                }
            };

            let dst_file = match std::fs::File::create(dst) {
                Ok(f) => f,
                Err(e) => {
                    errors.push(format!("{name}: {e}"));
                    continue;
                }
            };

            if cancelled.load(Ordering::Relaxed) {
                drop(dst_file);
                let _ = std::fs::remove_file(dst);
                errors.push(format!("{name}: Cancelled"));
                break;
            }

            let mut reader = std::io::BufReader::new(src_file);
            let mut writer = std::io::BufWriter::new(dst_file);
            let mut copied: u64 = 0;
            let mut buf = vec![0u8; 64 * 1024]; // 64 KB chunks
            let mut last_percent = 0u8;

            loop {
                if cancelled.load(Ordering::Relaxed) {
                    drop(writer);
                    let _ = std::fs::remove_file(dst);
                    errors.push(format!("{name}: Cancelled"));
                    break;
                }

                let n = match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => {
                        errors.push(format!("{name}: {e}"));
                        break;
                    }
                };

                if let Err(e) = std::io::Write::write_all(&mut writer, &buf[..n]) {
                    errors.push(format!("{name}: {e}"));
                    break;
                }

                copied += n as u64;
                let percent = if total > 0 {
                    ((copied as f64 / total as f64) * 100.0).min(100.0) as u8
                } else {
                    100
                };

                if percent != last_percent || copied == total {
                    last_percent = percent;
                    let _ = app.emit(
                        "copy-progress",
                        serde_json::json!({
                            "operationId": op_id,
                            "source": entry.source,
                            "destination": entry.destination,
                            "copied": copied,
                            "total": total,
                            "percent": percent,
                        }),
                    );
                }
            }
        }
        errors
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?;

    // Clean up cancel token
    state
        .tokens
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&operation_id);

    Ok(errors)
}

pub(crate) struct PtySession {
    pair: PtyPair,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    reader: Arc<Mutex<Box<dyn Read + Send>>>,
    child: Arc<Mutex<Box<dyn PtyChild + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

pub struct LocalSessions {
    pub(crate) sessions: Mutex<HashMap<String, PtySession>>,
}

#[tauri::command]
async fn connect_local(
    app_handle: tauri::AppHandle,
    session_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, LocalSessions>,
) -> Result<(), String> {
    let shell_path = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            "cmd.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        }
    });

    let args: Vec<String> = if cfg!(target_os = "windows") {
        if shell_path.ends_with("cmd.exe") {
            vec!["/K".to_string()]
        } else if shell_path.contains("pwsh") || shell_path.contains("powershell") {
            vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                "".to_string(),
            ]
        } else if shell_path.contains("wsl") {
            // Let WSL use its default configured shell; no args needed
            vec![]
        } else {
            // Git Bash or other sh-based shells
            vec!["-l".to_string()]
        }
    } else {
        vec!["-l".to_string()]
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open pty: {e}"))?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell_path.clone());
    cmd.args(args);
    cmd.env(OsString::from("TERM"), OsString::from("xterm-256color"));
    cmd.env(OsString::from("COLORTERM"), OsString::from("truecolor"));
    cmd.env(OsString::from("LANG"), OsString::from("en_US.UTF-8"));
    cmd.env(OsString::from("LC_ALL"), OsString::from("en_US.UTF-8"));

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn: {e}"))?;
    let child_killer = child.clone_killer();

    {
        let mut sessions = state.sessions.lock().map_err(|_| "Lock failed")?;
        sessions.insert(
            session_id.clone(),
            PtySession {
                pair,
                writer: Arc::new(Mutex::new(writer)),
                reader: Arc::new(Mutex::new(reader)),
                child: Arc::new(Mutex::new(child as Box<dyn PtyChild + Send>)),
                killer: Arc::new(Mutex::new(
                    child_killer as Box<dyn ChildKiller + Send + Sync>,
                )),
            },
        );
    }

    // Emit connected event
    let sid2 = session_id.clone();
    let handle = app_handle.clone();
    let _ = handle.emit(
        "ssh-output",
        serde_json::json!({"sessionId": sid2, "type": "connected", "data": ""}),
    );

    // Read loop: use a dedicated OS thread because the PTY read is blocking.
    // Running it on the Tokio executor would stall a worker thread.
    let sid_read = session_id.clone();
    let handle_read = app_handle.clone();
    let reader_arc_clone = {
        let sessions = state.sessions.lock().map_err(|_| "Lock failed")?;
        sessions.get(&session_id).map(|s| Arc::clone(&s.reader))
    };
    let _ = thread::Builder::new()
        .name(format!("pty-read-{sid_read}"))
        .spawn(move || {
            let Some(reader_arc) = reader_arc_clone else {
                return;
            };
            let mut buf = [0u8; 4096];
            loop {
                let n = match reader_arc.lock() {
                    Ok(mut r) => r.read(&mut buf),
                    Err(_) => break,
                };
                match n {
                    Ok(0) => {
                        let _ = handle_read.emit(
                            "ssh-output",
                            serde_json::json!({"sessionId": sid_read.clone(), "type": "disconnected", "data": ""}),
                        );
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        if !data.is_empty() {
                            let _ = handle_read.emit(
                                "ssh-output",
                                serde_json::json!({"sessionId": sid_read.clone(), "type": "output", "data": data}),
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
        });

    Ok(())
}

#[tauri::command]
async fn send_input_local(
    session_id: String,
    data: String,
    state: tauri::State<'_, LocalSessions>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "Lock failed")?;
    if let Some(pty) = sessions.get(&session_id) {
        if let Ok(mut w) = pty.writer.lock() {
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn resize_local(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, LocalSessions>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "Lock failed")?;
    if let Some(pty) = sessions.get(&session_id) {
        pty.pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn disconnect_local(
    session_id: String,
    state: tauri::State<'_, LocalSessions>,
) -> Result<(), String> {
    let pty = {
        let mut sessions = state.sessions.lock().map_err(|_| "Lock failed")?;
        sessions.remove(&session_id)
    };
    if let Some(pty) = pty {
        if let Ok(mut killer) = pty.killer.lock() {
            let _ = killer.kill();
        }
        if let Ok(mut child) = pty.child.lock() {
            let _ = child.wait();
        }
    }
    Ok(())
}

fn get_or_create_device_id() -> String {
    let dirs = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let path = dirs.join("termvault").join("device_id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &id);
    id
}

pub struct CryptoState {
    pub session: std::sync::Mutex<crypto::KeySession>,
}

#[tauri::command]
fn generate_account_material(
    state: tauri::State<'_, CryptoState>,
) -> Result<crypto::AccountMaterial, String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::generate_account_material(&mut session)
}

#[tauri::command]
fn generate_recovery_code() -> String {
    crypto::generate_recovery_code()
}

#[tauri::command]
fn derive_kek(
    password: String,
    salt_cl: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::derive_kek(&password, &salt_cl, &mut session)
}

#[tauri::command]
fn compute_login_proof(
    server_salt: String,
    nonce: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<crypto::LoginProof, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session
        .kek
        .ok_or("KEK not derived - call derive_kek first")?;
    crypto::compute_login_proof(&kek, &server_salt, &nonce)
}

#[tauri::command]
fn build_keyring_rows(
    recovery_code: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<crypto::KeyringRows, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session
        .kek
        .ok_or("KEK not derived - call derive_kek first")?;
    crypto::build_keyring_rows(&kek, &recovery_code, &session)
}

#[tauri::command]
fn encrypt_secret(
    plaintext: String,
    record_type: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::encrypt_secret(&plaintext, &record_type, &session)
}

#[tauri::command]
fn decrypt_secret(
    payload: String,
    db: tauri::State<'_, db::LocalDb>,
    state: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let header: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| "invalid ciphertext".to_string())?;
    if header.get("v").and_then(serde_json::Value::as_u64) == Some(2) {
        let table = header
            .get("record_type")
            .and_then(serde_json::Value::as_str)
            .ok_or("team record type missing")?;
        let vault_id = header
            .get("vault_id")
            .and_then(serde_json::Value::as_str)
            .ok_or("team vault ID missing")?;
        team_keys::decrypt_row_secret(&db, &session, &payload, table, vault_id)
    } else {
        crypto::decrypt_secret(&payload, &session)
    }
}

#[tauri::command]
fn cache_team_vault_metadata(
    vault_id: String,
    team_id: String,
    owner_id: String,
    name: String,
    epoch: u32,
    rotation_state: String,
    db: tauri::State<'_, db::LocalDb>,
) -> Result<(), String> {
    db::import_team_vault_metadata(&db, &vault_id, &team_id, &owner_id, &name, epoch, &rotation_state)
}

#[tauri::command]
fn identity_key_fingerprint(public_key: String) -> Result<String, String> {
    team_keys::fingerprint_identity_key(&public_key)
}

#[tauri::command]
fn is_team_vault(vault_id: String, db: tauri::State<'_, db::LocalDb>) -> Result<bool, String> {
    Ok(db::team_vault_meta(&db, &vault_id)?.is_some())
}

#[tauri::command]
fn team_vault_recovery_status(
    vault_id: String,
    db: tauri::State<'_, db::LocalDb>,
) -> Result<serde_json::Value, String> {
    let Some((_, _, state)) = db::team_vault_meta(&db, &vault_id)? else {
        return Err("not a team vault".into());
    };
    let pending = db::sync_db::pending_count(&db, &vault_id)?;
    Ok(serde_json::json!({"state": state, "pending": pending}))
}

#[tauri::command]
fn revoke_cached_team_vault_command(
    vault_id: String,
    db: tauri::State<'_, db::LocalDb>,
) -> Result<usize, String> {
    db::revoke_cached_team_vault(&db, &vault_id)
}

#[tauri::command]
fn revoke_cached_team_command(
    team_id: String,
    db: tauri::State<'_, db::LocalDb>,
) -> Result<usize, String> {
    db::revoke_cached_team(&db, &team_id)
}

#[tauri::command]
fn list_revoked_team_edits(
    db: tauri::State<'_, db::LocalDb>,
) -> Result<Vec<db::sync_db::RevokedVaultEdits>, String> {
    db::sync_db::list_revoked_pending_edits(&db)
}

#[tauri::command]
fn export_revoked_team_edits(
    vault_id: String,
    db: tauri::State<'_, db::LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<Vec<team_keys::ExportedPendingEdit>, String> {
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    team_keys::export_revoked_pending_edits(&db, &session, &vault_id)
}

#[tauri::command]
fn discard_revoked_team_edits(
    vault_id: String,
    db: tauri::State<'_, db::LocalDb>,
) -> Result<usize, String> {
    db::sync_db::discard_revoked_pending_edits(&db, &vault_id)
}

#[tauri::command]
fn prepare_team_rotation(
    team_id: String,
    vault_id: String,
    expected_epoch: u32,
    expected_revision: u32,
    rows: Vec<team_keys::RotationRow>,
    recipients: Vec<team_keys::RecipientKey>,
    db: tauri::State<'_, db::LocalDb>,
    state: tauri::State<'_, CryptoState>,
) -> Result<team_keys::PreparedRotation, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    team_keys::prepare_rotation(&db, &session, &team_id, &vault_id, expected_epoch, expected_revision, rows, recipients)
}

#[tauri::command]
fn create_team_vault_key(
    vault_id: String,
    team_id: String,
    recipients: Vec<team_keys::RecipientKey>,
    db: tauri::State<'_, db::LocalDb>,
    state: tauri::State<'_, CryptoState>,
) -> Result<Vec<team_keys::TeamKeyEnvelope>, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    team_keys::create_team_grants(&db, &session, &team_id, &vault_id, &recipients)
}

#[tauri::command]
fn grant_team_vault_key(
    vault_id: String,
    recipient: team_keys::RecipientKey,
    db: tauri::State<'_, db::LocalDb>,
    state: tauri::State<'_, CryptoState>,
) -> Result<team_keys::TeamKeyEnvelope, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    team_keys::grant_team_key(&db, &session, &vault_id, &recipient)
}

#[tauri::command]
fn import_team_key_envelope(
    envelope: team_keys::TeamKeyEnvelope,
    user_id: String,
    db: tauri::State<'_, db::LocalDb>,
    state: tauri::State<'_, CryptoState>,
) -> Result<(), String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    team_keys::import_team_grant(&db, &session, &user_id, &envelope)
}

#[tauri::command]
fn unwrap_dek(wrapped: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session
        .kek
        .ok_or("KEK not derived - call derive_kek first")?;
    crypto::unwrap_dek(&kek, &wrapped, &mut session)
}

#[tauri::command]
fn recovery_unwrap_dek(
    recovery_code: String,
    salt_cl: String,
    wrapped: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::recovery_unwrap_dek(&recovery_code, &salt_cl, &wrapped, &mut session)
}

#[tauri::command]
fn unwrap_private_key(wrapped: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    if session.dek == [0u8; 32] {
        return Err("DEK not derived - unlock or recover first".to_string());
    }
    crypto::unwrap_private_key(&wrapped, &mut session)
}

#[tauri::command]
fn wrap_dek_with_recovery(
    recovery_code: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    // The account salt lives in the session (derived at auth); wrapping under
    // it guarantees the kit is recoverable via the server-stored salt_cl.
    let salt_cl = BASE64.encode(session.salt_cl);
    crypto::wrap_dek_with_recovery(&recovery_code, &salt_cl, &session)
}

#[tauri::command]
fn sign_challenge(nonce: String, state: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::sign_challenge(&nonce, &session)
}

#[tauri::command]
fn lock_session(state: tauri::State<'_, CryptoState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::lock(&mut session);
    Ok(())
}

#[tauri::command]
fn unlock(
    password: String,
    salt_cl: String,
    wrapped_dek: String,
    state: tauri::State<'_, CryptoState>,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::unlock(&password, &salt_cl, &wrapped_dek, &mut session)
}

#[tauri::command]
fn wrap_dek(state: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::wrap_dek(&session)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_keyring_store::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin({
            let builder = tauri_plugin_prevent_default::Builder::new();
            #[cfg(target_os = "windows")]
            let builder = builder.platform(PlatformOptions::new().browser_accelerator_keys(false));
            builder.build()
        })
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;
            window.set_title("TermVault")?;

            let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let db_path = data_dir.join(db::DB_FILE_NAME);
            app.manage(db::open(&db_path.display().to_string())?);

            let handle = app.handle().clone();
            app.listen("main-ready", move |_| {
                let splash = handle.get_webview_window("splashscreen");
                let main = handle.get_webview_window("main");
                if let Some(s) = splash {
                    let _ = s.close();
                }
                if let Some(m) = main {
                    let _ = m.show();
                }
            });

            Ok(())
        })
        .manage(AppState {
            device_id: get_or_create_device_id(),
            api_url: Mutex::new(None),
        })
        .manage(CancelTokens {
            tokens: Mutex::new(HashMap::new()),
        })
        .manage(HistoryRecorderState::default())
        .manage(CryptoState {
            session: std::sync::Mutex::new(crypto::KeySession::new()),
        })
        .manage(http::HttpState::new(http::DEFAULT_BASE_URL.to_string()))
        .manage(sync::SyncLocks::default())
        .manage(git::GitLock(std::sync::Arc::new(Mutex::new(()))))
        .manage(LocalSessions {
            sessions: Mutex::new(HashMap::new()),
        })
        .manage(ssh::SshSessions::new(
            dirs::data_local_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("termvault"),
        ))
        .manage(forwarding::runtime::ForwardingState::new())
        .manage(sftp::SftpSessions::new())
        .manage(oauth::OAuthListener::default())
        .invoke_handler(tauri::generate_handler![
            update::update_installation_kind,
            get_device_id,
            history_start_attempt,
            history_mark_connected,
            history_append_output,
            history_flush_output,
            history_finish_attempt,
            history_list,
            history_recover_interrupted,
            history_get_output,
            history_delete,
            history_get_retention,
            history_set_retention,
            history_apply_retention,
            set_api_url,
            get_api_url,
            wipe_local_data,
            offline_auth::save_offline_identity_command,
            offline_auth::load_offline_identity_command,
            offline_auth::clear_offline_identity_command,
            db_upsert,
            cache_team_vault_metadata,
            is_team_vault,
            team_vault_recovery_status,
            revoke_cached_team_vault_command,
            revoke_cached_team_command,
            list_revoked_team_edits,
            export_revoked_team_edits,
            discard_revoked_team_edits,
            identity_key_fingerprint,
            create_team_vault_key,
            prepare_team_rotation,
            grant_team_vault_key,
            import_team_key_envelope,
            db_get,
            db_list,
            db_delete,
            db_outbox,
            db_update_sort_orders,
            db_update_host_group,
            forwarding::list_port_forwards,
            forwarding::create_port_forward,
            forwarding::update_port_forward,
            forwarding::delete_port_forward,
            forwarding::start_port_forward,
            forwarding::stop_port_forward,
            forwarding::stop_port_forwards_for_owner,
            write_file,
            detect_shells,
            is_same_volume,
            get_file_size,
            is_directory,
            fs_exists,
            fs_mkdir,
            fs_remove,
            fs_copy,
            fs_rename,
            copy_files_with_progress,
            cancel_copy,
            connect_local,
            send_input_local,
            resize_local,
            disconnect_local,
            ssh::connect,
            keys::derive_public_key,
            keys::inspect_private_key,
            keys::generate_ssh_key,
            ssh::connect_saved,
            ssh::disconnect,
            ssh::send_input,
            ssh::resize,
            ssh::accept_host_key,
            ssh::ping_host_saved,
            sftp::sftp_connect,
            sftp::sftp_connect_saved,
            sftp::sftp_disconnect,
            sftp::sftp_list,
            sftp::sftp_stat,
            sftp::sftp_read,
            sftp::sftp_write,
            sftp::sftp_mkdir,
            sftp::sftp_mkdir_all,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_chmod,
            sftp::sftp_chown,
            sftp::sftp_symlink,
            sftp::sftp_readlink,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_server_copy,
            sftp::sftp_search,
            sftp::sftp_cancel_transfer,
            oauth::bind_oauth_listener,
            oauth::await_oauth_callback,
            oauth::cancel_oauth_listener,
            git::git_status,
            git::git_stage,
            git::git_stage_all,
            git::git_unstage,
            git::git_unstage_all,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_log,
            git::git_switch_branch,
            git::git_create_branch,
            git::git_delete_branch,
            git::git_show_file,
            git::git_conflict_stages,
            git::git_resolve_conflict,
            git::git_pull,
            git::git_push,
            git::git_publish,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            generate_account_material,
            generate_recovery_code,
            derive_kek,
            compute_login_proof,
            build_keyring_rows,
            encrypt_secret,
            decrypt_secret,
            unwrap_dek,
            recovery_unwrap_dek,
            unwrap_private_key,
            wrap_dek_with_recovery,
            sign_challenge,
            lock_session,
            unlock,
            wrap_dek,
            sync::sync_now,
            http::http_request,
            http::set_auth_tokens,
            http::clear_auth_tokens,
            http::set_base_url,
            http::get_request_log,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Failed to run TermVault: {e}");
            std::process::exit(1);
        });
}
