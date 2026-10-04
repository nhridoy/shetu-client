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
        std::env::temp_dir().join(format!("terra-known-hosts-{stamp}.txt"))
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

    #[test]
    fn host_key_prompt_watch_pauses_network_timeout_only_while_prompt_is_pending() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let watch = HostKeyPromptWatch::new(Arc::clone(&pending), "target.internal", 22);
        assert!(!watch.is_waiting());
        let (tx, _rx) = oneshot::channel();
        pending.lock().unwrap().insert("target.internal:22".to_string(), vec![tx]);
        assert!(watch.is_waiting());
        pending.lock().unwrap().remove("target.internal:22");
        assert!(!watch.is_waiting());
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
}

pub struct SessionSlot {
    pub cmd_tx: mpsc::Sender<SessionCmd>,
    pub writer_handle: tokio::task::JoinHandle<()>,
}

pub struct SshSessions {
    pub sessions: Arc<Mutex<HashMap<String, SessionSlot>>>,
    pub inflight: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub pending_keys: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
    pub known_hosts: Arc<Mutex<KnownHosts>>,
}

impl SshSessions {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            pending_keys: Arc::new(Mutex::new(HashMap::new())),
            known_hosts: Arc::new(Mutex::new(KnownHosts::load(&data_dir.join(KNOWN_HOSTS_FILE)))),
        }
    }
}

pub struct SshHandler {
    host: String,
    port: u16,
    session_id: String,
    app: tauri::AppHandle,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
    auto_accept: bool,
    forwarded: Option<mpsc::Sender<(russh::Channel<russh::client::Msg>, russh::client::ChannelOpenHandle)>>,
    forward_bind: Option<(String, u32)>,
    require_known_host: bool,
}

pub(crate) struct HostKeyPromptWatch {
    pending: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
    key: String,
}

impl HostKeyPromptWatch {
    pub(crate) fn new(
        pending: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
        host: &str,
        port: u16,
    ) -> Self {
        Self { pending, key: format!("{host}:{port}") }
    }

    pub(crate) fn is_waiting(&self) -> bool {
        self.pending.lock().map(|pending| pending.contains_key(&self.key)).unwrap_or(false)
    }
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, session_id: &str, step: &str) {
    let _ = app.emit(
        "ssh-progress",
        serde_json::json!({ "sessionId": session_id, "step": step }),
    );
}

impl SshHandler {
    pub(crate) fn prompt_watch(&self) -> HostKeyPromptWatch {
        HostKeyPromptWatch::new(Arc::clone(&self.pending_keys), &self.host, self.port)
    }

    pub fn new(
        host: String,
        port: u16,
        session_id: String,
        app: tauri::AppHandle,
        known_hosts: Arc<Mutex<KnownHosts>>,
        pending_keys: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
        auto_accept: bool,
    ) -> Self {
        Self { host, port, session_id, app, known_hosts, pending_keys, auto_accept, forwarded: None, forward_bind: None, require_known_host: false }
    }
    pub(crate) fn with_forwarded_channels(
        mut self,
        sender: mpsc::Sender<(russh::Channel<russh::client::Msg>, russh::client::ChannelOpenHandle)>,
        address: String,
        port: u32,
    ) -> Self {
        self.forwarded = Some(sender);
        self.forward_bind = Some((address, port));
        self
    }

    pub(crate) fn require_known_host(mut self) -> Self {
        self.require_known_host = true;
        self
    }

}

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if self.forward_bind.as_ref().is_some_and(|(address, port)| {
            let address_matches = address == "0.0.0.0"
                || address == connected_address
                || (address == "127.0.0.1" && connected_address == "localhost");
            address_matches && *port == connected_port
        }) {
            if let Some(sender) = &self.forwarded {
                let _ = sender.send((channel, reply)).await;
            }
        }
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        emit_progress(&self.app, &self.session_id, "host_key");
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
                if self.require_known_host { return Ok(false); }
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
        let host_port_key = format!("{}:{}", host, port);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending_keys
                .lock()
                .map_err(|_| std::io::Error::other("pending_keys lock poisoned"))?;
            if let Some(existing) = pending.get_mut(&host_port_key) {
                existing.push(tx);
            } else {
                pending.insert(host_port_key.clone(), vec![tx]);
                let _ = self.app.emit(
                    "ssh-host-key-changed",
                    serde_json::json!({
                        "host": host,
                        "port": port,
                        "sessionId": self.session_id.clone(),
                        "oldFingerprint": old.unwrap_or_default(),
                        "newFingerprint": fingerprint,
                    }),
                );
            }
        }
        let accepted = rx.await.ok().unwrap_or(false);
        self.pending_keys
            .lock()
            .map_err(|_| std::io::Error::other("pending_keys lock poisoned"))?
            .remove(&host_port_key);
        if accepted {
            self.known_hosts
                .lock()
                .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?
                .accept(&host, port, &fingerprint);
            Ok(true)
        } else {
            Ok(false)
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

pub(crate) async fn connect_authenticated(
    handler: SshHandler,
    config: &SshConfig,
    progress: Option<(&tauri::AppHandle, &str)>,
) -> Result<russh::client::Handle<SshHandler>, String> {
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "resolving");
    }
    let addr = resolve_addr(&config.host, config.port).await?;
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "connecting");
    }
    let socket = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map_err(|_| format!("connection timeout to {}:{}", config.host, config.port))?
    .map_err(|e| format!("connect {}:{}: {e}", config.host, config.port))?;
    authenticate_over_stream(handler, config, socket, progress).await
}

pub(crate) async fn authenticate_over_stream<R>(
    handler: SshHandler,
    config: &SshConfig,
    stream: R,
    progress: Option<(&tauri::AppHandle, &str)>,
) -> Result<russh::client::Handle<SshHandler>, String>
where R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let client_config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect_stream(client_config, stream, handler)
        .await
        .map_err(|e| format!("ssh handshake {}:{}: {e}", config.host, config.port))?;
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "authenticating");
    }

    // No explicit credentials — send NONE auth request.
    // Servers that allow passwordless login (e.g. telehack.com) accept this;
    // others will reject it and we surface the error.
    if config.private_key.is_none() && config.password.is_none() {
        let auth = session
            .authenticate_none(config.username.clone())
            .await
            .map_err(|e| format!("none auth: {e}"))?;
        if !auth.success() {
            return Err("authentication required — add a password or SSH key".to_string());
        }
        return Ok(session);
    }

    // Try public key first if available
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
        if auth.success() {
            return Ok(session);
        }
        // Public key rejected — fall back to password if available
    }

    // Password auth (fallback or primary)
    if let Some(ref password) = config.password {
        let auth = session
            .authenticate_password(config.username.clone(), password.clone())
            .await
            .map_err(|e| format!("password auth: {e}"))?;
        if !auth.success() {
            return Err("authentication rejected".to_string());
        }
        return Ok(session);
    }

    Err("no authentication method succeeded".to_string())
}

async fn probe_os(
    app: tauri::AppHandle,
    session_id: String,
    config: &SshConfig,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
) -> Option<String> {
    let handler = SshHandler::new(
        config.host.clone(),
        config.port,
        session_id,
        app,
        known_hosts,
        pending_keys,
        true,
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let session = connect_authenticated(handler, config, None).await.ok()?;
        let mut channel = session.channel_open_session().await.ok()?;
        channel
            .exec(
                true,
                "uname -s; echo __TERRA_OS_RELEASE__; cat /etc/os-release 2>/dev/null; cat /usr/lib/os-release 2>/dev/null",
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
        let (uname, os_release) = match out.split_once("__TERRA_OS_RELEASE__") {
            Some((a, b)) => (a, b),
            None => return None,
        };
        detect_os(uname, os_release).map(|os| os.to_string())
    })
    .await
    .ok()
    .flatten()
}

async fn probe_os_saved(
    app: tauri::AppHandle,
    session_id: String,
    route: &crate::ssh_route::SavedRoute,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<bool>>>>>,
) -> Option<String> {
    if route.bastion.is_none() {
        return probe_os(app, session_id, &route.target, known_hosts, pending_keys).await;
    }
    let target_handler = SshHandler::new(route.target.host.clone(), route.target.port, session_id.clone(), app.clone(), Arc::clone(&known_hosts), Arc::clone(&pending_keys), true);
    let bastion = route.bastion.as_ref()?;
    let bastion_handler = SshHandler::new(bastion.host.clone(), bastion.port, session_id, app, known_hosts, pending_keys, true);
    tokio::time::timeout(std::time::Duration::from_secs(12), async {
        let connection = crate::ssh_route::connect_saved_route(route, target_handler, bastion_handler, None).await.ok()?;
        let mut channel = connection.target.channel_open_session().await.ok()?;
        channel.exec(true, "uname -s; echo __TERRA_OS_RELEASE__; cat /etc/os-release 2>/dev/null; cat /usr/lib/os-release 2>/dev/null").await.ok()?;
        let mut out = String::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        let (uname, os_release) = out.split_once("__TERRA_OS_RELEASE__")?;
        detect_os(uname, os_release).map(str::to_string)
    }).await.ok().flatten()
}

#[tauri::command]
pub async fn connect(
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    run_connect_session(app_handle, session_id, config, None, None, &state, cols, rows).await;
    Ok(())
}

/// Connect to a saved host entirely in Rust: loads + decrypts the host and
/// key rows, so no plaintext credentials ever cross the IPC boundary.
#[tauri::command]
pub async fn connect_saved(
    app_handle: tauri::AppHandle,
    session_id: String,
    host_id: String,
    detect_os: bool,
    cols: u32,
    rows: u32,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let mut route = crate::ssh_route::resolve_saved_route(&db, &crypto, &host_id)?;
    let mut config = route.target.clone();
    config.detect_os = detect_os;
    route.target.detect_os = detect_os;
    let os = if detect_os {
        let existing_os = crate::db::get_sync_row(&db, crate::db::Table::Hosts, &host_id)?
            .and_then(|r| r.os);
        if existing_os.is_some() {
            existing_os
        } else {
            let detected = probe_os_saved(
                app_handle.clone(),
                session_id.clone(),
                &route,
                Arc::clone(&state.known_hosts),
                Arc::clone(&state.pending_keys),
            )
            .await;
            if let Some(ref os_val) = detected {
                let _ = crate::db::update_host_os(&db, &host_id, os_val);
            }
            detected
        }
    } else {
        None
    };
    run_connect_session(app_handle, session_id, config, Some(route), os, &state, cols, rows).await;
    Ok(())
}

async fn run_connect_session(
    app_handle: tauri::AppHandle,
    session_id: String,
    config: SshConfig,
    route: Option<crate::ssh_route::SavedRoute>,
    pre_detected_os: Option<String>,
    state: &SshSessions,
    cols: u32,
    rows: u32,
) {
    let known_hosts = Arc::clone(&state.known_hosts);
    let pending_keys = Arc::clone(&state.pending_keys);
    let sessions = Arc::clone(&state.sessions);
    let inflight_for_spawn = Arc::clone(&state.inflight);
    let inflight_for_insert = Arc::clone(&state.inflight);
    let sid = session_id.clone();
    let connect_session_id = session_id.clone();
    let handle = tokio::spawn(async move {
        let emit = |app: &tauri::AppHandle, type_: &str, data: &str| {
            let _ = app.emit(
                "ssh-output",
                serde_json::json!({ "sessionId": sid.clone(), "type": type_, "data": data }),
            );
        };

        let os = if pre_detected_os.is_some() {
            pre_detected_os
        } else if config.detect_os {
            if let Some(ref route) = route { probe_os_saved(
                app_handle.clone(), session_id.clone(), route,
                Arc::clone(&known_hosts), Arc::clone(&pending_keys),
            ).await } else { probe_os(
                app_handle.clone(),
                session_id.clone(),
                &config,
                Arc::clone(&known_hosts),
                Arc::clone(&pending_keys),
            )
            .await }
        } else {
            None
        };

        let handler = SshHandler::new(
            config.host.clone(),
            config.port,
            session_id.clone(),
            app_handle.clone(),
            Arc::clone(&known_hosts),
            Arc::clone(&pending_keys),
            false,
        );

        let routed = if let Some(ref route) = route {
            let bastion_config = route.bastion.as_ref().unwrap_or(&route.target);
            let bastion_handler = SshHandler::new(bastion_config.host.clone(), bastion_config.port, session_id.clone(), app_handle.clone(), Arc::clone(&known_hosts), Arc::clone(&pending_keys), false);
            crate::ssh_route::connect_saved_route(route, handler, bastion_handler, Some((&app_handle, &session_id))).await
        } else {
            connect_authenticated(handler, &config, Some((&app_handle, &session_id))).await
                .map(|target| crate::ssh_route::RouteConnection { target, bastion: None })
        };
        let connection = match routed {
            Ok(connection) => connection,
            Err(e) => {
                emit(&app_handle, "error", &e);
                emit(&app_handle, "disconnected", "");
                return;
            }
        };
        let session = connection.target;
        let _bastion = connection.bastion;

        emit_progress(&app_handle, &session_id, "starting_shell");
        let channel = match session.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                emit(&app_handle, "error", &e.to_string());
                emit(&app_handle, "disconnected", "");
                return;
            }
        };
        if let Err(e) = channel
            .request_pty(true, "xterm", cols, rows, 0, 0, &[])
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

        let (mut read_half, write_half) = channel.split();
        let (tx, rx) = mpsc::channel::<SessionCmd>(32);
        let (close_tx, close_rx) = oneshot::channel::<()>();
        let writer_handle = tokio::spawn(async move {
            let mut close_tx = Some(close_tx);
            let mut rx = rx;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    SessionCmd::Input(bytes) => {
                        if let Err(_) = write_half.data_bytes(bytes).await {
                            break;
                        }
                    }
                    SessionCmd::Resize(cols, rows) => {
                        if let Err(_) = write_half.window_change(cols, rows, 0, 0).await {
                            break;
                        }
                    }
                }
            }
            if let Some(tx) = close_tx.take() {
                let _ = tx.send(());
            }
        });
        {
            let mut sessions = match sessions.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            sessions.insert(
                session_id.clone(),
                SessionSlot { cmd_tx: tx, writer_handle },
            );
        }
        // Remove from inflight now that session is fully established
        inflight_for_spawn.lock().ok().map(|mut g| g.remove(&session_id));

        let _ = app_handle.emit(
            "ssh-output",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "connected",
                "data": "",
                "os": os,
            }),
        );

        let mut pending: Vec<u8> = Vec::new();
        let mut close_rx = close_rx;
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    let Some(msg) = msg else { break };
                    match msg {
                        russh::ChannelMsg::Data { data } => {
                            if data.is_empty() {
                                continue;
                            }
                            pending.extend_from_slice(&data);
                            match std::str::from_utf8(&pending) {
                                Ok(s) => {
                                    emit(&app_handle, "output", s);
                                    pending.clear();
                                }
                                Err(e) => {
                                    let valid = e.valid_up_to();
                                    let end = valid + e.error_len().unwrap_or(0);
                                    if end > 0 {
                                        emit(
                                            &app_handle,
                                            "output",
                                            &String::from_utf8_lossy(&pending[..end]),
                                        );
                                        pending.drain(..end);
                                    }
                                }
                            }
                        }
                        russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                _ = &mut close_rx => break,
            }
        }
        if !pending.is_empty() {
            emit(&app_handle, "output", &String::from_utf8_lossy(&pending));
        }
        // Remove session slot and abort writer
        if let Some(slot) = sessions.lock().ok().and_then(|mut g| g.remove(&session_id)) {
            slot.writer_handle.abort();
        }
        emit(&app_handle, "disconnected", "");
        // session handle drops here → connection closed
    });
    // Store inflight handle so disconnect can abort during probe/handshake
    inflight_for_insert.lock().ok().map(|mut g| g.insert(connect_session_id, handle));
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
        .map(|s| s.cmd_tx.clone());
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
        .map(|s| s.cmd_tx.clone());
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
    // Abort inflight connection attempt (during probe/handshake)
    if let Some(handle) = state
        .inflight
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        handle.abort();
    }
    // Abort writer + remove established session
    if let Some(slot) = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        slot.writer_handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn accept_host_key(
    host: String,
    port: u16,
    accepted: bool,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let host_port_key = format!("{}:{}", host, port);
    let senders = state
        .pending_keys
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&host_port_key);
    if let Some(senders) = senders {
        for tx in senders {
            let _ = tx.send(accepted);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ping_host_saved(
    app_handle: tauri::AppHandle,
    host_id: String,
    detect_os: bool,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, SshSessions>,
) -> Result<PingResult, String> {
    let mut route = crate::ssh_route::resolve_saved_route(&db, &crypto, &host_id)?;
    let mut config = route.target.clone();
    config.detect_os = detect_os;
    route.target.detect_os = detect_os;
    let timeout = std::time::Duration::from_millis(2000);
    let start = std::time::Instant::now();
    if route.bastion.is_some() {
        let target_handler = SshHandler::new(config.host.clone(), config.port, "ping".into(), app_handle.clone(), Arc::clone(&state.known_hosts), Arc::clone(&state.pending_keys), true);
        let bastion_config = route.bastion.as_ref().expect("checked above");
        let bastion_handler = SshHandler::new(bastion_config.host.clone(), bastion_config.port, "ping".into(), app_handle.clone(), Arc::clone(&state.known_hosts), Arc::clone(&state.pending_keys), true);
        let connected = tokio::time::timeout(std::time::Duration::from_secs(20), crate::ssh_route::connect_saved_route(&route, target_handler, bastion_handler, None)).await;
        match connected {
            Ok(Ok(connection)) => drop(connection),
            Ok(Err(error)) => return Err(error),
            Err(_) => return Ok(PingResult { reachable: false, latency_ms: None, os: None }),
        }
        let latency_ms = start.elapsed().as_millis() as u64;
        let os = if detect_os { probe_os_saved(app_handle, "ping".into(), &route, Arc::clone(&state.known_hosts), Arc::clone(&state.pending_keys)).await } else { None };
        if let Some(ref value) = os { let _ = crate::db::update_host_os(&db, &host_id, value); }
        return Ok(PingResult { reachable: true, latency_ms: Some(latency_ms), os });
    }
    let addr = resolve_addr(&config.host, config.port).await?;
    let connected = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await;
    match connected {
        Ok(Ok(_)) => {}
        _ => {
            return Ok(PingResult { reachable: false, latency_ms: None, os: None });
        }
    }
    let latency_ms = start.elapsed().as_millis() as u64;
    let os = if config.detect_os {
        probe_os(
            app_handle,
            "-".to_string(),
            &config,
            Arc::clone(&state.known_hosts),
            Arc::clone(&state.pending_keys),
        )
        .await
    } else {
        None
    };
    if let Some(ref os_val) = os {
        let _ = crate::db::update_host_os(&db, &host_id, os_val);
    }
    Ok(PingResult { reachable: true, latency_ms: Some(latency_ms), os })
}

/// Build the SSH config entirely in Rust from the saved (encrypted) host +
/// key rows. Sensitive material never crosses the IPC boundary.
pub fn load_host_config(
    db: &crate::db::LocalDb,
    crypto: &crate::CryptoState,
    host_id: &str,
) -> Result<SshConfig, String> {
    let row = crate::db::get_sync_row(db, crate::db::Table::Hosts, host_id)?
        .ok_or_else(|| "host not found".to_string())?;
    let session = crypto.session.lock().map_err(|e| e.to_string())?;
    let plaintext = crate::team_keys::decrypt_row_secret(db, &session, &row.data, "hosts", &row.vault_id)?;
    drop(session);
    let payload: serde_json::Value =
        serde_json::from_str(&plaintext).map_err(|e| format!("bad host payload: {e}"))?;
    let mut config = SshConfig {
        host: payload["address"].as_str().unwrap_or_default().to_string(),
        port: payload["port"].as_u64().unwrap_or(22) as u16,
        username: payload["username"].as_str().unwrap_or("root").to_string(),
        password: None,
        private_key: None,
        passphrase: None,
        detect_os: false,
    };
    let auth_type = row.auth_type.as_deref().unwrap_or("password");
    // Load password when auth_type is "password" or "both"
    if auth_type == "password" || auth_type == "both" {
        config.password = payload["password"].as_str().map(String::from);
    }
    // Load key when auth_type is "key" or "both"
    if auth_type == "key" || auth_type == "both" {
        if let Some(key_id) = row.key_id.as_deref() {
            let key_row = crate::db::get_sync_row(db, crate::db::Table::Keys, key_id)?
                .ok_or_else(|| "key not found".to_string())?;
            let session = crypto.session.lock().map_err(|e| e.to_string())?;
            let key_plain = crate::team_keys::decrypt_row_secret(db, &session, &key_row.data, "keys", &key_row.vault_id)?;
            drop(session);
            let key_payload: serde_json::Value = serde_json::from_str(&key_plain)
                .map_err(|e| format!("bad key payload: {e}"))?;
            config.private_key = key_payload["privateKey"].as_str().map(String::from);
            config.passphrase = key_payload["passphrase"].as_str().map(String::from);
        }
    }
    Ok(config)
}
