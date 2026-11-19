use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh_sftp::client::SftpSession as RusshSftp;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime: i64,
    pub atime: i64,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConnectResult {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

pub struct SftpSession {
    pub host_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub sftp: Arc<russh_sftp::client::SftpSession>,
    pub ssh_handle: Option<russh::client::Handle<crate::ssh::SshHandler>>,
    pub bastion_handle: Option<russh::client::Handle<crate::ssh::SshHandler>>,
    pub created_ourselves: bool,
}

#[derive(Clone)]
pub struct SftpSessions {
    pub sessions: Arc<Mutex<HashMap<String, SftpSession>>>,
}

impl Default for SftpSessions {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl SftpSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// The host a session is connected to, and its SFTP handle.
    pub fn session_info(&self, id: &str) -> Option<(crate::transfers::model::HostRef, Arc<RusshSftp>)> {
        let map = self.sessions.lock().ok()?;
        let s = map.get(id)?;
        Some((
            crate::transfers::model::HostRef {
                host_id: s.host_id.clone(),
                host: s.host.clone(),
                port: s.port,
                username: s.username.clone(),
            },
            Arc::clone(&s.sftp),
        ))
    }

    /// An open session to `host`, trying `prefer` first. Saved hosts match on host id + user,
    /// quick-connect hosts on address, port and user.
    pub fn find_matching(
        &self,
        host: &crate::transfers::model::HostRef,
        prefer: Option<&str>,
    ) -> Option<(String, crate::transfers::model::HostRef, Arc<RusshSftp>)> {
        let map = self.sessions.lock().ok()?;
        let fits = |s: &SftpSession| {
            let open = s.ssh_handle.as_ref().is_none_or(|h| !h.is_closed());
            let same = match &host.host_id {
                Some(id) => s.host_id.as_ref() == Some(id) && s.username == host.username,
                None => s.host == host.host && s.port == host.port && s.username == host.username,
            };
            open && same
        };
        prefer
            .and_then(|id| map.get_key_value(id))
            .filter(|(_, s)| fits(s))
            .or_else(|| map.iter().find(|(_, s)| fits(s)))
            .map(|(id, s)| {
                let found = crate::transfers::model::HostRef {
                    host_id: s.host_id.clone(),
                    host: s.host.clone(),
                    port: s.port,
                    username: s.username.clone(),
                };
                (id.clone(), found, Arc::clone(&s.sftp))
            })
    }

    /// The session `id` if its connection is still open, with the host it is connected to.
    pub fn get_open(
        &self,
        id: &str,
    ) -> Option<(String, crate::transfers::model::HostRef, Arc<RusshSftp>)> {
        let map = self.sessions.lock().ok()?;
        let s = map.get(id)?;
        if s.ssh_handle.as_ref().is_some_and(|h| h.is_closed()) {
            return None;
        }
        let host = crate::transfers::model::HostRef {
            host_id: s.host_id.clone(),
            host: s.host.clone(),
            port: s.port,
            username: s.username.clone(),
        };
        Some((id.to_string(), host, Arc::clone(&s.sftp)))
    }

    /// Closes and forgets a session (and its SSH connection when we opened it).
    pub async fn disconnect(&self, session_id: &str) {
        if let Some(session) = self.take(session_id) {
            close_session(session).await;
        }
    }

    /// Forgets a session at once, so no one can look it up; close it with `close_session`.
    pub fn take(&self, session_id: &str) -> Option<SftpSession> {
        self.sessions.lock().ok().and_then(|mut m| m.remove(session_id))
    }
}

pub async fn close_session(session: SftpSession) {
    let _ = session.sftp.close().await;
    if session.created_ourselves {
        drop(session.ssh_handle);
    }
}

async fn open_sftp_from_handle(
    handle: &russh::client::Handle<crate::ssh::SshHandler>,
) -> Result<RusshSftp, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("request sftp subsystem: {e}"))?;
    RusshSftp::new(channel.into_stream())
        .await
        .map_err(|e| format!("init sftp session: {e}"))
}

/// Reuse an existing SFTP session only while its SSH connection is open
/// (`Some(false)` = handle present and not closed).
fn should_reuse(handle_closed: Option<bool>) -> bool {
    handle_closed == Some(false)
}

#[tauri::command]
pub async fn sftp_connect(
    session_id: String,
    config: crate::ssh::SshConfig,
    _db: tauri::State<'_, crate::db::LocalDb>,
    _crypto: tauri::State<'_, crate::CryptoState>,
    ssh_sessions: tauri::State<'_, crate::ssh::SshSessions>,
    sftp_sessions: tauri::State<'_, SftpSessions>,
    app_handle: tauri::AppHandle,
) -> Result<SftpConnectResult, String> {
    crate::logging::hide(&config.username);
    // Check if we already have an SFTP session for this session_id
    {
        let mut sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
        let reusable = sessions
            .get(&session_id)
            .map(|e| should_reuse(e.ssh_handle.as_ref().map(|h| h.is_closed())));
        if reusable == Some(false) {
            // Stale (keepalive closed it): drop and reconnect.
            sessions.remove(&session_id);
        }
        if let Some(existing) = sessions.get(&session_id) {
            return Ok(SftpConnectResult {
                session_id,
                host: existing.host.clone(),
                port: existing.port,
                username: existing.username.clone(),
                reused: true,
                host_id: existing.host_id.clone(),
            });
        }
    }

    // Create new SSH connection and open SFTP on it
    let handler = crate::ssh::SshHandler::new(
        config.host.clone(),
        config.port,
        session_id.clone(),
        app_handle.clone(),
        Arc::clone(&ssh_sessions.known_hosts),
        Arc::clone(&ssh_sessions.pending_keys),
        false,
    ).with_prompts(&ssh_sessions.pending_prompts);
    let ssh = crate::ssh::connect_authenticated(handler, &config, Some((&app_handle, &session_id))).await?;

    crate::ssh::emit_progress(&app_handle, &session_id, "sftp_channel");
    let sftp = open_sftp_from_handle(&ssh).await?;

    let result = SftpConnectResult {
        session_id: session_id.clone(),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        reused: false,
        host_id: None,
    };

    let sftp_session = SftpSession {
        host_id: None,
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        sftp: Arc::new(sftp),
        ssh_handle: Some(ssh),
        bastion_handle: None,
        created_ourselves: true,
    };

    let mut sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(session_id, sftp_session);

    Ok(result)
}

#[tauri::command]
pub async fn sftp_connect_saved(
    session_id: String,
    host_id: String,
    username: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<SftpConnectResult, String> {
    connect_saved_session(&app_handle, session_id, host_id, username).await
}

/// Opens (or reuses) the SFTP session `session_id` to a saved host. Also used by the transfer
/// manager to reconnect in the background; prompts go through the app-wide dialogs.
pub async fn connect_saved_session(
    app: &tauri::AppHandle,
    session_id: String,
    host_id: String,
    username: Option<String>,
) -> Result<SftpConnectResult, String> {
    use tauri::Manager;
    let app_handle = app.clone();
    let db = app.state::<crate::db::LocalDb>();
    let crypto = app.state::<crate::CryptoState>();
    let ssh_sessions = app.state::<crate::ssh::SshSessions>();
    let sftp_sessions = app.state::<SftpSessions>();
    let route = crate::ssh_route::resolve_saved_route_as(&db, &crypto, &host_id, username.as_deref())?;
    let config = &route.target;

    // Check if we already have an SFTP session for this session_id
    {
        let mut sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
        let reusable = sessions
            .get(&session_id)
            .map(|e| should_reuse(e.ssh_handle.as_ref().map(|h| h.is_closed())));
        if reusable == Some(false) {
            // Stale (keepalive closed it): drop and reconnect.
            sessions.remove(&session_id);
        }
        if let Some(existing) = sessions.get(&session_id) {
            return Ok(SftpConnectResult {
                session_id,
                host: existing.host.clone(),
                port: existing.port,
                username: existing.username.clone(),
                reused: true,
                host_id: existing.host_id.clone(),
            });
        }
    }

    // Create new SSH connection and open SFTP on it
    let handler = crate::ssh::SshHandler::new(
        config.host.clone(),
        config.port,
        session_id.clone(),
        app_handle.clone(),
        Arc::clone(&ssh_sessions.known_hosts),
        Arc::clone(&ssh_sessions.pending_keys),
        false,
    ).with_prompts(&ssh_sessions.pending_prompts);
    let bastion_config = route.bastion.as_ref().unwrap_or(config);
    let bastion_handler = crate::ssh::SshHandler::new(
        bastion_config.host.clone(), bastion_config.port, session_id.clone(), app_handle.clone(),
        Arc::clone(&ssh_sessions.known_hosts), Arc::clone(&ssh_sessions.pending_keys), false,
    ).with_prompts(&ssh_sessions.pending_prompts);
    let connection = crate::ssh_route::connect_saved_route(&route, handler, bastion_handler, Some((&app_handle, &session_id))).await?;

    crate::ssh::emit_progress(&app_handle, &session_id, "sftp_channel");
    let sftp = open_sftp_from_handle(&connection.target).await?;

    let result = SftpConnectResult {
        session_id: session_id.clone(),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        reused: false,
        host_id: Some(host_id.clone()),
    };

    let sftp_session = SftpSession {
        host_id: Some(host_id),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        sftp: Arc::new(sftp),
        ssh_handle: Some(connection.target),
        bastion_handle: connection.bastion,
        created_ourselves: true,
    };

    let mut sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(session_id, sftp_session);

    Ok(result)
}

#[tauri::command]
pub async fn sftp_disconnect(
    session_id: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    sftp_sessions.disconnect(&session_id).await;
    Ok(())
}

/// Join a parent directory path with a child name, normalizing a single
/// trailing slash on the parent (e.g. `/var` + `log` => `/var/log`,
/// `/var/` + `log` => `/var/log`, `` + `tmp` => `tmp`).
fn join_sftp_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        return name.to_string();
    }
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

fn attrs_to_entry(name: String, path: String, attrs: &russh_sftp::client::fs::Metadata) -> SftpEntry {
    SftpEntry {
        name,
        path,
        is_dir: attrs.is_dir(),
        is_symlink: attrs.is_symlink(),
        size: attrs.len(),
        mode: attrs.permissions.unwrap_or(0),
        uid: attrs.uid.unwrap_or(0),
        gid: attrs.gid.unwrap_or(0),
        mtime: attrs.mtime.unwrap_or(0) as i64,
        atime: attrs.atime.unwrap_or(0) as i64,
        symlink_target: None,
    }
}

fn get_sftp(
    sessions: &SftpSessions,
    session_id: &str,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let map = sessions.sessions.lock().map_err(|e| e.to_string())?;
    let session = map.get(session_id).ok_or("SFTP session not found")?;
    Ok(Arc::clone(&session.sftp))
}

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;
    let read_dir = sftp.read_dir(&path).await.map_err(|e| format!("list: {e}"))?;

    let entries = read_dir
        .filter_map(|entry| {
            let name = entry.file_name();
            let full_path = entry.path();
            let attrs = entry.metadata();
            Some(attrs_to_entry(name, full_path, &attrs))
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_stat(
    session_id: String,
    path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<SftpEntry, String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;
    let attrs = sftp.metadata(&path).await.map_err(|e| format!("stat: {e}"))?;
    let name = path.split('/').last().unwrap_or("").to_string();

    Ok(attrs_to_entry(name, path, &attrs))
}

#[tauri::command]
pub async fn sftp_read(
    session_id: String,
    path: String,
    offset: u64,
    len: u32,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let sftp = get_sftp(&sftp_sessions, &session_id)?;
    let mut file = sftp.open(&path).await.map_err(|e| format!("open: {e}"))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("seek: {e}"))?;

    let mut buf = vec![0u8; len as usize];
    let n = file.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
    buf.truncate(n);
    Ok(buf)
}

#[tauri::command]
pub async fn sftp_write(
    session_id: String,
    path: String,
    data: Vec<u8>,
    offset: u64,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    use tokio::io::{AsyncSeekExt, AsyncWriteExt};

    let mut file = sftp
        .open_with_flags(
            &path,
            russh_sftp::protocol::OpenFlags::CREATE
                | russh_sftp::protocol::OpenFlags::WRITE
                | russh_sftp::protocol::OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("open: {e}"))?;

    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("seek: {e}"))?;
    file.write_all(&data)
        .await
        .map_err(|e| format!("write: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("fsync: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("mkdir: {e}"))
}

#[tauri::command]
pub async fn sftp_mkdir_all(
    session_id: String,
    paths: Vec<String>,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let mut acc = String::new();
        if path.starts_with('/') {
            acc.push('/');
        }
        for part in path.split('/').filter(|p| !p.is_empty()) {
            if acc.is_empty() || acc == "/" {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            match sftp.create_dir(&acc).await {
                Ok(_) => {}
                Err(e) => match sftp.metadata(&acc).await {
                    Ok(m) if m.is_dir() => {}
                    _ => return Err(format!("mkdir: {}: {}", acc, e)),
                },
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    sftp.rename(&old_path, &new_path)
        .await
        .map_err(|e| format!("rename: {e}"))
}

async fn sftp_delete_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), String> {
    let metadata = sftp
        .metadata(path)
        .await
        .map_err(|e| format!("stat: {e}"))?;
    if metadata.is_dir() {
        let read_dir = sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("readdir: {e}"))?;
        for entry in read_dir {
            let entry_path = join_sftp_path(path, &entry.file_name());
            Box::pin(sftp_delete_recursive(sftp, &entry_path)).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|e| format!("rmdir: {e}"))
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|e| format!("rm: {e}"))
    }
}

#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    recursive: bool,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    if recursive {
        return sftp_delete_recursive(&sftp, &path).await;
    }

    let metadata = sftp
        .metadata(&path)
        .await
        .map_err(|e| format!("stat: {e}"))?;
    if metadata.is_dir() {
        sftp.remove_dir(&path)
            .await
            .map_err(|e| format!("rmdir: {e}"))
    } else {
        sftp.remove_file(&path)
            .await
            .map_err(|e| format!("rm: {e}"))
    }
}

#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(mode);

    sftp.set_metadata(&path, attrs)
        .await
        .map_err(|e| format!("chmod: {e}"))
}

#[tauri::command]
pub async fn sftp_chown(
    session_id: String,
    path: String,
    uid: u32,
    gid: u32,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.uid = Some(uid);
    attrs.gid = Some(gid);

    sftp.set_metadata(&path, attrs)
        .await
        .map_err(|e| format!("chown: {e}"))
}

#[tauri::command]
pub async fn sftp_symlink(
    session_id: String,
    target: String,
    link_path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    sftp.symlink(&target, &link_path)
        .await
        .map_err(|e| format!("symlink: {e}"))
}

#[tauri::command]
pub async fn sftp_readlink(
    session_id: String,
    path: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<String, String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;

    sftp.read_link(&path)
        .await
        .map_err(|e| format!("readlink: {e}"))
}

#[tauri::command]
pub async fn sftp_search(
    session_id: String,
    path: String,
    query: String,
    sftp_sessions: tauri::State<'_, SftpSessions>,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = get_sftp(&sftp_sessions, &session_id)?;
    let mut results = Vec::new();
    let query_lower = query.to_lowercase();

    search_recursive(&sftp, &path, &query_lower, &mut results, 1000).await?;
    Ok(results)
}

fn search_recursive<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    current_path: &'a str,
    query: &'a str,
    results: &'a mut Vec<SftpEntry>,
    max_results: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if results.len() >= max_results {
            return Ok(());
        }

        let read_dir = sftp
            .read_dir(current_path)
            .await
            .map_err(|e| format!("readdir: {e}"))?;

        let entries: Vec<_> = read_dir
            .filter_map(|entry| {
                let name = entry.file_name();
                let entry_path = join_sftp_path(current_path, &name);
                let attrs = entry.metadata();
                Some((name, entry_path, attrs))
            })
            .collect();

        for (name, entry_path, attrs) in entries {
            if results.len() >= max_results {
                break;
            }

            if name.to_lowercase().contains(query) {
                results.push(attrs_to_entry(name, entry_path.clone(), &attrs));
            }

            if attrs.is_dir() {
                search_recursive(sftp, &entry_path, query, results, max_results).await?;
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_only_when_connection_open() {
        assert!(should_reuse(Some(false)));
        assert!(!should_reuse(Some(true)));
        assert!(!should_reuse(None));
    }

    #[test]
    fn join_sftp_path_handles_trailing_slash() {
        assert_eq!(join_sftp_path("/var", "log"), "/var/log");
        assert_eq!(join_sftp_path("/var/", "log"), "/var/log");
        assert_eq!(join_sftp_path("/var//", "log"), "/var/log");
    }

    #[test]
    fn join_sftp_path_handles_root_and_empty_parent() {
        assert_eq!(join_sftp_path("", "tmp"), "tmp");
        assert_eq!(join_sftp_path("/", "tmp"), "/tmp");
        assert_eq!(join_sftp_path("/home/user", ""), "/home/user/");
    }

    #[test]
    fn join_sftp_path_handles_nested_names() {
        assert_eq!(join_sftp_path("/a/b", "c/d"), "/a/b/c/d");
        assert_eq!(join_sftp_path("relative", "file.txt"), "relative/file.txt");
    }
}
