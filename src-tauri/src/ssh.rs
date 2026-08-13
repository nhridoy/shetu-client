use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};

pub struct KnownHosts {
    path: PathBuf,
    entries: Vec<KnownHostEntry>,
}

struct KnownHostEntry {
    host: String,
    port: u16,
    fingerprint: String,
}

#[derive(PartialEq, Debug)]
pub enum HostKeyStatus {
    Unknown,
    Known,
    Changed,
}

impl KnownHosts {
    pub fn load(path: &Path) -> Self {
        let entries = std::fs::read_to_string(path)
            .map(|contents| {
                contents
                    .lines()
                    .filter_map(|line| {
                        let mut parts = line.split('|');
                        let host = parts.next()?;
                        let port = parts.next()?.parse::<u16>().ok()?;
                        let fingerprint = parts.next()?.to_string();
                        if host.is_empty() || fingerprint.is_empty() {
                            return None;
                        }
                        Some(KnownHostEntry { host: host.to_string(), port, fingerprint })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { path: path.to_path_buf(), entries }
    }

    pub fn check(&self, host: &str, port: u16, fingerprint: &str) -> HostKeyStatus {
        let mut saw_entry = false;
        for entry in &self.entries {
            if entry.host == host && entry.port == port {
                saw_entry = true;
                if entry.fingerprint == fingerprint {
                    return HostKeyStatus::Known;
                }
            }
        }
        if saw_entry {
            HostKeyStatus::Changed
        } else {
            HostKeyStatus::Unknown
        }
    }

    pub fn get_fingerprint(&self, host: &str, port: u16) -> Option<String> {
        self.entries
            .iter()
            .find(|e| e.host == host && e.port == port)
            .map(|e| e.fingerprint.clone())
    }

    pub fn accept(&mut self, host: &str, port: u16, fingerprint: &str) {
        self.entries.retain(|e| !(e.host == host && e.port == port));
        self.entries.push(KnownHostEntry {
            host: host.to_string(),
            port,
            fingerprint: fingerprint.to_string(),
        });
        let contents = self
            .entries
            .iter()
            .map(|e| format!("{}|{}|{}", e.host, e.port, e.fingerprint))
            .collect::<Vec<_>>()
            .join("\n");
        // Persistence failures must be visible: a silently-lost accepted
        // fingerprint would re-trigger TOFU acceptance later and could mask
        // a genuine key change (MITM window).
        if let Some(parent) = self.path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("ssh: failed to create known_hosts dir: {e}");
            }
        }
        if let Err(e) = std::fs::write(&self.path, contents) {
            eprintln!("ssh: failed to persist known_hosts: {e}");
        }
    }
}

const KNOWN_OS_IDS: &[(&str, &str)] = &[
    ("ubuntu", "ubuntu"),
    ("debian", "debian"),
    ("fedora", "fedora"),
    ("arch", "arch"),
    ("manjaro", "manjaro"),
    ("linuxmint", "linuxmint"),
    ("pop", "pop"),
    ("kali", "kali"),
    ("alpine", "alpine"),
    ("centos", "centos"),
    ("rocky", "rocky"),
    ("alma", "alma"),
    ("rhel", "rhel"),
    ("amzn", "amazon"),
    ("opensuse", "opensuse"),
    ("opensuse-leap", "opensuse"),
    ("opensuse-tumbleweed", "opensuse"),
    ("sles", "sles"),
    ("nixos", "nixos"),
    ("gentoo", "gentoo"),
    ("zorin", "zorin"),
    ("elementary", "elementary"),
    ("ol", "oracle"),
    ("oraclelinux", "oracle"),
];

pub fn detect_os(uname: &str, os_release: &str) -> Option<&'static str> {
    let uname = uname.trim();
    if uname.contains("Darwin") {
        return Some("darwin");
    }
    if uname.contains("FreeBSD") || uname.contains("OpenBSD") || uname.contains("NetBSD") {
        return Some("bsd");
    }
    if uname.contains("SunOS") {
        return Some("solaris");
    }
    if uname.contains("MINGW") || uname.contains("MSYS") || uname.contains("CYGWIN") {
        return Some("windows");
    }
    if !uname.contains("Linux") {
        return None;
    }
    let id = os_release
        .lines()
        .find_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once('=')?;
            if key == "ID" {
                Some(value.trim_matches('"').trim().to_lowercase())
            } else {
                None
            }
        })
        .unwrap_or_default();
    if let Some(canonical) = canonical_os_id(&id) {
        return Some(canonical);
    }
    let id_like = os_release
        .lines()
        .find_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once('=')?;
            if key == "ID_LIKE" {
                Some(value.trim_matches('"').trim().to_lowercase())
            } else {
                None
            }
        })
        .unwrap_or_default();
    let first = id_like.split_whitespace().next().unwrap_or_default();
    if let Some(canonical) = canonical_os_id(first) {
        return Some(canonical);
    }
    Some("linux")
}

fn canonical_os_id(id: &str) -> Option<&'static str> {
    KNOWN_OS_IDS
        .iter()
        .find(|(raw, _)| *raw == id)
        .map(|(_, canonical)| *canonical)
}

pub fn fingerprint_of(server_public_key: &russh::keys::PublicKey) -> String {
    server_public_key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_path() -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("termvault-known-hosts-{stamp}.txt"))
    }

    #[test]
    fn os_detection_maps_platforms() {
        assert_eq!(detect_os("Linux", ""), Some("linux"));
        assert_eq!(detect_os("Darwin", ""), Some("darwin"));
        assert_eq!(detect_os("FreeBSD", ""), Some("bsd"));
        assert_eq!(detect_os("OpenBSD", ""), Some("bsd"));
        assert_eq!(detect_os("SunOS", ""), Some("solaris"));
        assert_eq!(detect_os("MINGW64_NT-10.0-26100", ""), Some("windows"));
        assert_eq!(detect_os("CYGWIN_NT-6.1", ""), Some("windows"));
        assert_eq!(detect_os("MSYS_NT-10.0", ""), Some("windows"));
        assert_eq!(detect_os("HP-UX", ""), None);
    }

    #[test]
    fn os_detection_parses_os_release_ids() {
        assert_eq!(detect_os("Linux", "ID=ubuntu\nVERSION_ID=24.04\n"), Some("ubuntu"));
        assert_eq!(detect_os("Linux", "ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"), Some("linuxmint"));
        assert_eq!(detect_os("Linux", "ID=pop\nID_LIKE=ubuntu\n"), Some("pop"));
        assert_eq!(detect_os("Linux", "ID=opensuse-leap\n"), Some("opensuse"));
        assert_eq!(detect_os("Linux", "ID=amzn\n"), Some("amazon"));
        assert_eq!(detect_os("Linux", "ID=someweirdos\nID_LIKE=debian\n"), Some("debian"));
        assert_eq!(detect_os("Linux", "ID=someweirdos\n"), Some("linux"));
        assert_eq!(detect_os("Linux", ""), Some("linux"));
    }

    #[test]
    fn known_hosts_tofu_flow() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Unknown);
        kh.accept("web", 22, "fp-a");
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Known);
        assert_eq!(kh.check("web", 22, "fp-b"), HostKeyStatus::Changed);
        assert_eq!(kh.get_fingerprint("web", 22), Some("fp-a".to_string()));
        // same host different port is a separate entry
        assert_eq!(kh.check("web", 2222, "fp-a"), HostKeyStatus::Unknown);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn known_hosts_persists_and_skips_corrupt_lines() {
        let path = tmp_path();
        std::fs::write(&path, "web|22|fp-a\ncorrupt-line-no-separators\nmail|25|fp-b\n").unwrap();
        let mut kh = KnownHosts::load(&path);
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Known);
        assert_eq!(kh.check("mail", 25, "fp-b"), HostKeyStatus::Known);
        // corrupt line is skipped, no crash
        kh.accept("web", 22, "fp-c");
        let reloaded = KnownHosts::load(&path);
        assert_eq!(reloaded.check("web", 22, "fp-c"), HostKeyStatus::Known);
        let _ = std::fs::remove_file(&path);
    }
}

pub const KNOWN_HOSTS_FILE: &str = "known_hosts";

#[derive(Default, Clone, Deserialize)]
#[serde(default)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub detect_os: bool,
}

#[derive(serde::Serialize)]
pub struct PingResult {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub os: Option<String>,
}

pub enum SessionCmd {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshSessions {
    pub sessions: Arc<Mutex<HashMap<String, mpsc::Sender<SessionCmd>>>>,
    pub pending_keys: Arc<Mutex<Vec<oneshot::Sender<bool>>>>,
    pub known_hosts: Arc<Mutex<KnownHosts>>,
}

impl SshSessions {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_keys: Arc::new(Mutex::new(Vec::new())),
            known_hosts: Arc::new(Mutex::new(KnownHosts::load(&data_dir.join(KNOWN_HOSTS_FILE)))),
        }
    }
}

struct SshHandler {
    host: String,
    port: u16,
    app: tauri::AppHandle,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: Arc<Mutex<Vec<oneshot::Sender<bool>>>>,
    auto_accept: bool,
}

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = fingerprint_of(server_public_key);
        let (host, port) = (self.host.clone(), self.port);
        let known = {
            let kh = self
                .known_hosts
                .lock()
                .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?;
            kh.check(&host, port, &fingerprint)
        };
        match known {
            HostKeyStatus::Unknown => {
                self.known_hosts
                    .lock()
                    .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?
                    .accept(&host, port, &fingerprint);
                return Ok(true);
            }
            HostKeyStatus::Known => return Ok(true),
            HostKeyStatus::Changed => {
                if self.auto_accept {
                    return Ok(false);
                }
            }
        }
        let old = self
            .known_hosts
            .lock()
            .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?
            .get_fingerprint(&host, port);
        let (tx, rx) = oneshot::channel();
        self.pending_keys
            .lock()
            .map_err(|_| std::io::Error::other("pending_keys lock poisoned"))?
            .push(tx);
        let _ = self.app.emit(
            "ssh-host-key-changed",
            serde_json::json!({
                "host": host,
                "port": port,
                "oldFingerprint": old.unwrap_or_default(),
                "newFingerprint": fingerprint,
            }),
        );
        match rx.await {
            Ok(true) => {
                self.known_hosts
                    .lock()
                    .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?
                    .accept(&host, port, &fingerprint);
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

async fn resolve_addr(host: &str, port: u16) -> Result<std::net::SocketAddr, String> {
    tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("dns lookup {host}:{port}: {e}"))?
        .next()
        .ok_or_else(|| format!("no address for {host}:{port}"))
}

async fn connect_authenticated(
    handler: SshHandler,
    config: &SshConfig,
) -> Result<russh::client::Handle<SshHandler>, String> {
    let addr = resolve_addr(&config.host, config.port).await?;
    let client_config = Arc::new(russh::client::Config::default());
    let mut session = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        russh::client::connect(client_config, addr, handler),
    )
    .await
    .map_err(|_| format!("connection timeout to {}:{}", config.host, config.port))?
    .map_err(|e| format!("connect {}:{}: {e}", config.host, config.port))?;

    if let Some(pem) = config.private_key.as_deref() {
        let key = russh::keys::decode_secret_key(pem, config.passphrase.as_deref())
            .map_err(|e| format!("decode private key: {e}"))?;
        let key_with_alg = russh::keys::key::PrivateKeyWithHashAlg::new(
            Arc::new(key),
            Some(russh::keys::HashAlg::Sha256),
        );
        let auth = session
            .authenticate_publickey(config.username.clone(), key_with_alg)
            .await
            .map_err(|e| format!("publickey auth: {e}"))?;
        if !auth.success() {
            return Err("public key authentication rejected".to_string());
        }
    } else {
        let auth = session
            .authenticate_password(
                config.username.clone(),
                config.password.clone().unwrap_or_default(),
            )
            .await
            .map_err(|e| format!("password auth: {e}"))?;
        if !auth.success() {
            return Err("password authentication rejected".to_string());
        }
    }
    Ok(session)
}

async fn probe_os(
    app: tauri::AppHandle,
    config: &SshConfig,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: Arc<Mutex<Vec<oneshot::Sender<bool>>>>,
) -> Option<String> {
    let handler = SshHandler {
        host: config.host.clone(),
        port: config.port,
        app,
        known_hosts,
        pending_keys,
        auto_accept: true,
    };
    let session = connect_authenticated(handler, config).await.ok()?;
    let mut channel = session.channel_open_session().await.ok()?;
    channel
        .exec(
            true,
            "uname -s; echo __TERMVAULT_OS_RELEASE__; cat /etc/os-release 2>/dev/null; cat /usr/lib/os-release 2>/dev/null",
        )
        .await
        .ok()?;
    let mut out = String::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    let (uname, os_release) = match out.split_once("__TERMVAULT_OS_RELEASE__") {
        Some((a, b)) => (a, b),
        None => return None,
    };
    detect_os(uname, os_release).map(|os| os.to_string())
}

#[tauri::command]
pub async fn connect(
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let known_hosts = Arc::clone(&state.known_hosts);
    let pending_keys = Arc::clone(&state.pending_keys);
    let sessions = Arc::clone(&state.sessions);
    let sid = session_id.clone();
    tokio::spawn(async move {
        let emit = |app: &tauri::AppHandle, type_: &str, data: &str| {
            let _ = app.emit(
                "ssh-output",
                serde_json::json!({ "sessionId": sid.clone(), "type": type_, "data": data }),
            );
        };

        let os = if config.detect_os {
            probe_os(app_handle.clone(), &config, Arc::clone(&known_hosts), Arc::clone(&pending_keys)).await
        } else {
            None
        };

        let handler = SshHandler {
            host: config.host.clone(),
            port: config.port,
            app: app_handle.clone(),
            known_hosts: Arc::clone(&known_hosts),
            pending_keys: Arc::clone(&pending_keys),
            auto_accept: false,
        };

        let session = match connect_authenticated(handler, &config).await {
            Ok(s) => s,
            Err(e) => {
                emit(&app_handle, "error", &e);
                emit(&app_handle, "disconnected", "");
                return;
            }
        };

        let mut channel = match session.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                emit(&app_handle, "error", &e.to_string());
                emit(&app_handle, "disconnected", "");
                return;
            }
        };
        if let Err(e) = channel
            .request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
        {
            emit(&app_handle, "error", &e.to_string());
            emit(&app_handle, "disconnected", "");
            return;
        }
        if let Err(e) = channel.request_shell(true).await {
            emit(&app_handle, "error", &e.to_string());
            emit(&app_handle, "disconnected", "");
            return;
        }

        let (tx, mut rx) = mpsc::channel::<SessionCmd>(32);
        {
            let mut sessions = match sessions.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            sessions.insert(session_id.clone(), tx);
        }

        let _ = app_handle.emit(
            "ssh-output",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "connected",
                "data": "",
                "os": os,
            }),
        );

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    let Some(msg) = msg else { break };
                    match msg {
                        russh::ChannelMsg::Data { data } => {
                            let text = String::from_utf8_lossy(&data);
                            if !text.is_empty() {
                                emit(&app_handle, "output", &text);
                            }
                        }
                        russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCmd::Input(bytes)) => {
                            let _ = channel.data_bytes(bytes).await;
                        }
                        Some(SessionCmd::Resize(cols, rows)) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(SessionCmd::Close) | None => break,
                    }
                }
            }
        }

        let _ = sessions.lock().map(|mut g| g.remove(&session_id));
        emit(&app_handle, "disconnected", "");
        // session handle drops here → connection closed
    });
    Ok(())
}

#[tauri::command]
pub async fn send_input(
    session_id: String,
    data: String,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let tx = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned();
    if let Some(tx) = tx {
        tx.send(SessionCmd::Input(data.into_bytes()))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let tx = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned();
    if let Some(tx) = tx {
        tx.send(SessionCmd::Resize(cols as u32, rows as u32))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn disconnect(
    session_id: String,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let tx = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&session_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(SessionCmd::Close).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn accept_host_key(
    accepted: bool,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let senders = std::mem::take(&mut *state.pending_keys.lock().map_err(|e| e.to_string())?);
    for tx in senders {
        let _ = tx.send(accepted);
    }
    Ok(())
}

#[tauri::command]
pub async fn ping_host(
    app_handle: tauri::AppHandle,
    config: SshConfig,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, SshSessions>,
) -> Result<PingResult, String> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(2000));
    let start = std::time::Instant::now();
    let addr = resolve_addr(&config.host, config.port).await?;
    let connected = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await;
    match connected {
        Ok(Ok(_)) => {}
        _ => {
            return Ok(PingResult { reachable: false, latency_ms: None, os: None });
        }
    }
    let latency_ms = start.elapsed().as_millis() as u64;
    let os = probe_os(
        app_handle,
        &config,
        Arc::clone(&state.known_hosts),
        Arc::clone(&state.pending_keys),
    )
    .await;
    Ok(PingResult { reachable: true, latency_ms: Some(latency_ms), os })
}