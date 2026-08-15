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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpTransferProgress {
    pub session_id: String,
    pub transfer_id: String,
    pub transfer_type: String,
    pub path: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub speed: f64,
}

pub struct SftpSession {
    pub host_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub sftp: russh_sftp::client::SftpSession,
    pub ssh_handle: Option<russh::client::Handle<crate::ssh::SshHandler>>,
    pub created_ourselves: bool,
}

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
    // Check if we already have an SFTP session for this session_id
    {
        let sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
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
    );
    let client_config = Arc::new(russh::client::Config::default());
    let mut ssh = russh::client::connect_stream(
        client_config,
        tokio::net::TcpStream::connect(format!("{}:{}", config.host, config.port))
            .await
            .map_err(|e| format!("tcp connect: {e}"))?,
        handler,
    )
    .await
    .map_err(|e| format!("ssh handshake: {e}"))?;

    // Authenticate
    if let Some(ref key) = config.private_key {
        let key = russh::keys::decode_secret_key(key, config.passphrase.as_deref())
            .map_err(|e| format!("decode key: {e}"))?;
        let key_with_alg = russh::keys::key::PrivateKeyWithHashAlg::new(
            Arc::new(key),
            Some(russh::keys::HashAlg::Sha256),
        );
        let auth = ssh
            .authenticate_publickey(config.username.clone(), key_with_alg)
            .await
            .map_err(|e| format!("publickey auth: {e}"))?;
        if !auth.success() {
            return Err("public key authentication rejected".to_string());
        }
    } else if let Some(ref password) = config.password {
        let auth = ssh
            .authenticate_password(config.username.clone(), password.clone())
            .await
            .map_err(|e| format!("password auth: {e}"))?;
        if !auth.success() {
            return Err("password authentication rejected".to_string());
        }
    } else {
        let auth = ssh
            .authenticate_none(config.username.clone())
            .await
            .map_err(|e| format!("none auth: {e}"))?;
        if !auth.success() {
            return Err("authentication required".to_string());
        }
    }

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
        host: config.host,
        port: config.port,
        username: config.username,
        sftp,
        ssh_handle: Some(ssh),
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
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    ssh_sessions: tauri::State<'_, crate::ssh::SshSessions>,
    sftp_sessions: tauri::State<'_, SftpSessions>,
    app_handle: tauri::AppHandle,
) -> Result<SftpConnectResult, String> {
    let config = crate::ssh::load_host_config(&db, &crypto, &host_id)?;

    // Check if we already have an SFTP session for this session_id
    {
        let sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
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
    );
    let client_config = Arc::new(russh::client::Config::default());
    let mut ssh = russh::client::connect_stream(
        client_config,
        tokio::net::TcpStream::connect(format!("{}:{}", config.host, config.port))
            .await
            .map_err(|e| format!("tcp connect: {e}"))?,
        handler,
    )
    .await
    .map_err(|e| format!("ssh handshake: {e}"))?;

    // Authenticate
    if let Some(ref key) = config.private_key {
        let key = russh::keys::decode_secret_key(key, config.passphrase.as_deref())
            .map_err(|e| format!("decode key: {e}"))?;
        let key_with_alg = russh::keys::key::PrivateKeyWithHashAlg::new(
            Arc::new(key),
            Some(russh::keys::HashAlg::Sha256),
        );
        let auth = ssh
            .authenticate_publickey(config.username.clone(), key_with_alg)
            .await
            .map_err(|e| format!("publickey auth: {e}"))?;
        if !auth.success() {
            return Err("public key authentication rejected".to_string());
        }
    } else if let Some(ref password) = config.password {
        let auth = ssh
            .authenticate_password(config.username.clone(), password.clone())
            .await
            .map_err(|e| format!("password auth: {e}"))?;
        if !auth.success() {
            return Err("password authentication rejected".to_string());
        }
    } else {
        let auth = ssh
            .authenticate_none(config.username.clone())
            .await
            .map_err(|e| format!("none auth: {e}"))?;
        if !auth.success() {
            return Err("authentication required".to_string());
        }
    }

    let sftp = open_sftp_from_handle(&ssh).await?;

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
        host: config.host,
        port: config.port,
        username: config.username,
        sftp,
        ssh_handle: Some(ssh),
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
    let session = {
        let mut sessions = sftp_sessions.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&session_id)
    };
    if let Some(session) = session {
        let _ = session.sftp.close().await;
        if session.created_ourselves {
            drop(session.ssh_handle);
        }
    }
    Ok(())
}
