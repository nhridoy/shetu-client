#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod crypto;
mod db;
mod http;
mod oauth;
mod ssh;
mod sftp;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use base64::{engine::general_purpose::STANDARD_NO_PAD as BASE64, Engine};
use portable_pty::{native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_prevent_default::PlatformOptions;

pub struct AppState {
    pub device_id: String,
    pub api_url: Mutex<Option<String>>,
}

pub struct CancelTokens {
    pub tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
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
fn wipe_local_data(db: tauri::State<'_, db::LocalDb>) -> Result<(), String> {
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
) -> Result<db::SyncRow, String> {
    let table = db::Table::parse(&table)?;
    let mut row: db::SyncRow = serde_json::from_value(row).map_err(|e| format!("db_upsert: bad row: {e}"))?;
    if let Some(plaintext) = plaintext {
        let session = crypto.session.lock().map_err(|e| e.to_string())?;
        let rt = record_type.as_deref().unwrap_or(table.as_str());
        row.data = crypto::encrypt_secret(&plaintext, rt, &session)?;
    }
    db::upsert_sync_row(&db, table, &row)}

#[tauri::command]
fn db_get(db: tauri::State<'_, db::LocalDb>, table: String, id: String) -> Result<Option<db::SyncRow>, String> {
    let table = db::Table::parse(&table)?;
    db::get_sync_row(&db, table, &id)
}

#[tauri::command]
fn db_list(db: tauri::State<'_, db::LocalDb>, table: String, vault_id: String, include_deleted: Option<bool>) -> Result<Vec<db::SyncRow>, String> {
    let table = db::Table::parse(&table)?;
    db::list_sync_rows(&db, table, &vault_id, include_deleted.unwrap_or(false))
}

#[tauri::command]
fn db_delete(db: tauri::State<'_, db::LocalDb>, table: String, id: String) -> Result<(), String> {
    let table = db::Table::parse(&table)?;
    db::tombstone_sync_row(&db, table, &id)
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
) -> Result<(), String> {
    let table = db::Table::parse(&table)?;
    let pairs: Vec<(String, i64)> = updates.into_iter().map(|u| (u.id, u.sort_order)).collect();
    db::update_sort_orders(&db, table, &pairs)
}

#[tauri::command]
fn db_update_host_group(
    db: tauri::State<'_, db::LocalDb>,
    host_id: String,
    group_id: String,
) -> Result<(), String> {
    db::update_host_group(&db, &host_id, &group_id)
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
        shells.push(ShellInfo { name: "PowerShell 7".to_string(), ..s });
    }
    // Windows PowerShell
    if let Some(s) = probe_shell("powershell.exe", &["-NoProfile", "-Command", "echo ok"]) {
        shells.push(ShellInfo { name: "PowerShell".to_string(), ..s });
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
        let shell_name = user_shell
            .split('/')
            .last()
            .unwrap_or("shell")
            .to_string();
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
        let shell_name = user_shell
            .split('/')
            .last()
            .unwrap_or("shell")
            .to_string();
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
        let meta = std::fs::symlink_metadata(&p)
            .map_err(|e| format!("{path}: {e}"))?;
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
        std::fs::copy(&src, &dst)
            .map_err(|e| format!("{source} -> {dest}: {e}"))?;
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
fn cancel_copy(
    state: tauri::State<'_, CancelTokens>,
    operation_id: String,
) -> Result<(), String> {
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

pub struct LocalSessions {
    pub ptys: Mutex<HashMap<String, Arc<Mutex<PtyPair>>>>,
    pub writers: Mutex<HashMap<String, Arc<Mutex<Box<dyn Write + Send>>>>>,
    pub readers: Mutex<HashMap<String, Arc<Mutex<Box<dyn Read + Send>>>>>,
    pub killers: Mutex<HashMap<String, Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>>>,
    pub children: Mutex<HashMap<String, Arc<Mutex<Box<dyn PtyChild + Send>>>>>,
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
            vec!["-NoExit".to_string(), "-Command".to_string(), "".to_string()]
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
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to open pty: {e}"))?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell_path.clone());
    cmd.args(args);
    cmd.env(OsString::from("TERM"), OsString::from("xterm-256color"));
    cmd.env(OsString::from("COLORTERM"), OsString::from("truecolor"));
    cmd.env(OsString::from("LANG"), OsString::from("en_US.UTF-8"));
    cmd.env(OsString::from("LC_ALL"), OsString::from("en_US.UTF-8"));

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn: {e}"))?;
    let child_killer = child.clone_killer();

    {
        let mut ptys = state.ptys.lock().map_err(|_| "Lock failed")?;
        ptys.insert(session_id.clone(), Arc::new(Mutex::new(pair)));

        let mut writers = state.writers.lock().map_err(|_| "Lock failed")?;
        writers.insert(session_id.clone(), Arc::new(Mutex::new(Box::new(writer) as Box<dyn Write + Send>)));

        let mut readers = state.readers.lock().map_err(|_| "Lock failed")?;
        readers.insert(session_id.clone(), Arc::new(Mutex::new(Box::new(reader) as Box<dyn Read + Send>)));

        let mut killers = state.killers.lock().map_err(|_| "Lock failed")?;
        killers.insert(session_id.clone(), Arc::new(Mutex::new(child_killer as Box<dyn ChildKiller + Send + Sync>)));

        let mut children = state.children.lock().map_err(|_| "Lock failed")?;
        children.insert(session_id.clone(), Arc::new(Mutex::new(child as Box<dyn PtyChild + Send>)));
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
        let readers = state.readers.lock().unwrap();
        readers.get(&session_id).cloned()
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
    let writers = state.writers.lock().map_err(|_| "Lock failed")?;
    if let Some(writer_arc) = writers.get(&session_id) {
        if let Ok(mut w) = writer_arc.lock() {
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
    let ptys = state.ptys.lock().map_err(|_| "Lock failed")?;
    if let Some(pair_arc) = ptys.get(&session_id) {
        if let Ok(pair) = pair_arc.lock() {
            pair.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn disconnect_local(
    session_id: String,
    state: tauri::State<'_, LocalSessions>,
) -> Result<(), String> {
    // Remove killer and child first so we can consume them
    let killer_opt = {
        let mut killers = state.killers.lock().map_err(|_| "Lock failed")?;
        killers.remove(&session_id)
    };
    let child_opt = {
        let mut children = state.children.lock().map_err(|_| "Lock failed")?;
        children.remove(&session_id)
    };
    if let Some(killer_arc) = killer_opt {
        let mut killer = killer_arc.lock().unwrap();
        let _ = killer.kill();
    }
    // Reap the child so the process + ConPTY are fully released (no leaks)
    if let Some(child_arc) = child_opt {
        let mut child = child_arc.lock().unwrap();
        let _ = child.wait();
    }
    // Clean up all stored resources
    {
        let mut ptys = state.ptys.lock().map_err(|_| "Lock failed")?;
        ptys.remove(&session_id);
        let mut writers = state.writers.lock().map_err(|_| "Lock failed")?;
        writers.remove(&session_id);
        let mut readers = state.readers.lock().map_err(|_| "Lock failed")?;
        readers.remove(&session_id);
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
fn generate_account_material(state: tauri::State<'_, CryptoState>) -> Result<crypto::AccountMaterial, String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::generate_account_material(&mut session)
}

#[tauri::command]
fn generate_recovery_code() -> String {
    crypto::generate_recovery_code()
}

#[tauri::command]
fn derive_kek(password: String, salt_cl: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::derive_kek(&password, &salt_cl, &mut session)
}

#[tauri::command]
fn compute_login_proof(server_salt: String, nonce: String, state: tauri::State<'_, CryptoState>) -> Result<crypto::LoginProof, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session.kek.ok_or("KEK not derived - call derive_kek first")?;
    crypto::compute_login_proof(&kek, &server_salt, &nonce)
}

#[tauri::command]
fn build_keyring_rows(recovery_code: String, state: tauri::State<'_, CryptoState>) -> Result<crypto::KeyringRows, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session.kek.ok_or("KEK not derived - call derive_kek first")?;
    crypto::build_keyring_rows(&kek, &recovery_code, &session)
}

#[tauri::command]
fn encrypt_secret(plaintext: String, record_type: String, state: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::encrypt_secret(&plaintext, &record_type, &session)
}

#[tauri::command]
fn decrypt_secret(payload: String, state: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let session = state.session.lock().map_err(|e| e.to_string())?;
    crypto::decrypt_secret(&payload, &session)
}

#[tauri::command]
fn unwrap_dek(wrapped: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|e| e.to_string())?;
    let kek = session.kek.ok_or("KEK not derived - call derive_kek first")?;
    crypto::unwrap_dek(&kek, &wrapped, &mut session)
}

#[tauri::command]
fn recovery_unwrap_dek(recovery_code: String, salt_cl: String, wrapped: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
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
fn wrap_dek_with_recovery(recovery_code: String, state: tauri::State<'_, CryptoState>) -> Result<String, String> {
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
fn unlock(password: String, salt_cl: String, wrapped_dek: String, state: tauri::State<'_, CryptoState>) -> Result<(), String> {
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
        .plugin(
            tauri_plugin_prevent_default::Builder::new()
                .platform(PlatformOptions::new().browser_accelerator_keys(false))
                .build(),
        )
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
        .manage(CryptoState {
            session: std::sync::Mutex::new(crypto::KeySession::new()),
        })
        .manage(http::HttpState::new(http::DEFAULT_BASE_URL.to_string()))
        .manage(git::GitLock(std::sync::Arc::new(Mutex::new(()))))
        .manage(LocalSessions {
            ptys: Mutex::new(HashMap::new()),
            writers: Mutex::new(HashMap::new()),
            readers: Mutex::new(HashMap::new()),
            killers: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
        })
        .manage(ssh::SshSessions::new(
            dirs::data_local_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("termvault"),
        ))
        .manage(sftp::SftpSessions::new())
        .manage(oauth::OAuthListener::default())
        .invoke_handler(tauri::generate_handler![
            get_device_id,
            set_api_url,
            get_api_url,
            wipe_local_data,
            db_upsert,
            db_get,
            db_list,
            db_delete,
            db_outbox,
            db_update_sort_orders,
            db_update_host_group,
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
