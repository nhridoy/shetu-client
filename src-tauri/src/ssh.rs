use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};

pub struct KnownHosts {
    path: PathBuf,
    entries: Vec<KnownHostEntry>,
    /// User setting: interactive connections save first-seen keys without asking.
    pub trust_new_hosts: bool,
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

#[derive(PartialEq, Debug)]
pub enum HostKeyPromptKind {
    New,
    Changed,
}

#[derive(PartialEq, Debug)]
pub enum HostKeyDecision {
    Accept,
    Reject,
    Prompt(HostKeyPromptKind),
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
        Self { path: path.to_path_buf(), entries, trust_new_hosts: false }
    }

    /// Background (non-interactive) connections never trust a key the user has not seen.
    /// A first-seen key accepted via `trust_new_hosts` is saved here.
    pub fn decide(&mut self, host: &str, port: u16, fingerprint: &str, interactive: bool) -> HostKeyDecision {
        match self.check(host, port, fingerprint) {
            HostKeyStatus::Known => HostKeyDecision::Accept,
            _ if !interactive => HostKeyDecision::Reject,
            HostKeyStatus::Unknown if self.trust_new_hosts => {
                self.accept(host, port, fingerprint);
                HostKeyDecision::Accept
            }
            HostKeyStatus::Unknown => HostKeyDecision::Prompt(HostKeyPromptKind::New),
            HostKeyStatus::Changed => HostKeyDecision::Prompt(HostKeyPromptKind::Changed),
        }
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
        self.persist();
    }

    /// Memory is emptied even if the file rewrite fails; the error is returned.
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.entries.clear();
        self.write_file()
    }

    fn persist(&self) {
        if let Err(e) = self.write_file() {
            log::error!("ssh: failed to persist known_hosts: {e}");
        }
    }

    fn write_file(&self) -> std::io::Result<()> {
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
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, contents)
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
    #[tokio::test]
    async fn bridge_ends_when_one_side_closes_and_other_never_sends_eof() {
        let (agent, _agent_peer) = tokio::io::duplex(64);
        let (chan, chan_peer) = tokio::io::duplex(64);
        drop(chan_peer);
        tokio::time::timeout(std::time::Duration::from_secs(2), bridge(agent, chan))
            .await
            .expect("bridge returns");
    }

    #[test]
    fn agent_channel_rejected_without_flag() {
        assert!(accept_agent_channel(true));
        assert!(!accept_agent_channel(false));
    }

    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn close_reason_lost_only_on_write_failure() {
        let (tx, mut rx) = oneshot::channel::<bool>();
        drop(tx);
        let dropped = rx.try_recv();
        assert!(close_reason_is_lost::<()>(Ok(true)));
        assert!(!close_reason_is_lost::<()>(Ok(false)));
        assert!(dropped.is_err() && !close_reason_is_lost(dropped));
    }

    #[test]
    fn connection_lost_notice_text() {
        assert_eq!(CONNECTION_LOST_NOTICE, "\r\n[Connection lost]\r\n");
    }

    #[test]
    fn startup_bytes_adds_one_newline() {
        assert_eq!(startup_bytes("tmux a"), b"tmux a\n");
        assert_eq!(startup_bytes("a\nb\n"), b"a\nb\n");
    }

    fn tmp_path() -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("shetu-known-hosts-{stamp}.txt"))
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
    fn known_hosts_clear_empties_file_and_memory() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.accept("web", 22, "fp-a");
        kh.clear().unwrap();
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Unknown);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn known_hosts_clear_reports_write_failure() {
        use std::os::unix::fs::PermissionsExt;
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.accept("web", 22, "fp-a");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let is_root = std::process::Command::new("id")
            .arg("-u")
            .output()
            .is_ok_and(|o| o.stdout == b"0\n");
        let result = kh.clear();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        if !is_root {
            assert!(result.is_err());
            assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Unknown);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_key_on_interactive_connection_prompts_without_saving() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        assert_eq!(kh.decide("web", 22, "fp-a", true), HostKeyDecision::Prompt(HostKeyPromptKind::New));
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Unknown);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_key_on_background_connection_is_rejected_and_not_saved() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.trust_new_hosts = true;
        assert_eq!(kh.decide("web", 22, "fp-a", false), HostKeyDecision::Reject);
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Unknown);
        assert!(!path.exists());
    }

    #[test]
    fn trust_new_hosts_saves_unknown_key_without_prompt() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.trust_new_hosts = true;
        assert_eq!(kh.decide("web", 22, "fp-a", true), HostKeyDecision::Accept);
        assert_eq!(KnownHosts::load(&path).check("web", 22, "fp-a"), HostKeyStatus::Known);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changed_key_still_prompts_with_trust_new_hosts() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.accept("web", 22, "fp-a");
        kh.trust_new_hosts = true;
        assert_eq!(kh.decide("web", 22, "fp-b", true), HostKeyDecision::Prompt(HostKeyPromptKind::Changed));
        assert_eq!(kh.decide("web", 22, "fp-b", false), HostKeyDecision::Reject);
        assert_eq!(kh.check("web", 22, "fp-a"), HostKeyStatus::Known);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn known_key_is_accepted_everywhere() {
        let path = tmp_path();
        let mut kh = KnownHosts::load(&path);
        kh.accept("web", 22, "fp-a");
        assert_eq!(kh.decide("web", 22, "fp-a", true), HostKeyDecision::Accept);
        assert_eq!(kh.decide("web", 22, "fp-a", false), HostKeyDecision::Accept);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn host_key_answer_only_approves_the_fingerprint_shown() {
        let (tx_a, mut rx_a) = oneshot::channel();
        let (tx_b, mut rx_b) = oneshot::channel();
        settle_pending(vec![("fp-a".into(), tx_a), ("fp-b".into(), tx_b)], "fp-a", true);
        assert_eq!(rx_a.try_recv(), Ok(true));
        assert_eq!(rx_b.try_recv(), Ok(false));
        let (tx, mut rx) = oneshot::channel();
        settle_pending(vec![("fp-a".into(), tx)], "fp-a", false);
        assert_eq!(rx.try_recv(), Ok(false));
    }

    #[test]
    fn rejected_host_key_ends_connect_without_reconnect() {
        let rejected = format!("destination connection: ssh handshake web:22: {}", russh::Error::UnknownKey);
        assert_eq!(
            connect_failure_events(&rejected),
            vec![("error", "Connection cancelled: host key not trusted.".to_string())]
        );
        assert_eq!(
            connect_failure_events("connect web:22: refused"),
            vec![("error", "connect web:22: refused".to_string()), ("disconnected", String::new())]
        );
    }

    #[test]
    fn ping_reports_reachable_only_when_the_destination_key_is_untrusted() {
        use crate::ssh_route::{RouteError, RouteHop};
        let refused = format!("ssh handshake web:22: {}", russh::Error::UnknownKey);
        let target = ping_failure(RouteError { hop: RouteHop::Target, message: refused.clone() })
            .expect("the destination answered");
        assert!(target.reachable);
        assert_eq!(target.latency_ms, None);
        let bastion = ping_failure(RouteError { hop: RouteHop::Bastion, message: refused });
        assert_eq!(bastion.err(), Some("Jump host key not trusted".to_string()));
        let other = ping_failure(RouteError { hop: RouteHop::Target, message: "authentication rejected".into() });
        assert_eq!(other.err(), Some("authentication rejected".to_string()));
    }

    #[tokio::test]
    async fn prompter_round_trip() {
        let pending: PendingPrompts = Arc::new(Mutex::new(HashMap::new()));
        let answerer = Arc::clone(&pending);
        let answer = await_prompt_answer(&pending, "h:22".into(), move |id| {
            assert_eq!(answerer.lock().unwrap().len(), 1);
            settle_prompt(&answerer, id, Some(vec!["x".into()]));
        }, |_| panic!("answered prompt must not close"), AUTH_PROMPT_TIMEOUT).await;
        assert_eq!(answer, Some(vec!["x".to_string()]));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn late_answer_after_timeout_is_ignored() {
        tokio::time::pause();
        let pending: PendingPrompts = Arc::new(Mutex::new(HashMap::new()));
        let seen = Arc::new(Mutex::new(String::new()));
        let seen_in = Arc::clone(&seen);
        let answer = await_prompt_answer(&pending, "h:22".into(), move |id| *seen_in.lock().unwrap() = id.to_string(), |_| {}, AUTH_PROMPT_TIMEOUT).await;
        assert_eq!(answer, None);
        assert!(pending.lock().unwrap().is_empty());
        settle_prompt(&pending, &seen.lock().unwrap(), Some(vec!["late".into()]));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropped_prompt_future_clears_entry_and_reports_closed() {
        tokio::time::pause();
        let pending: PendingPrompts = Arc::new(Mutex::new(HashMap::new()));
        let seen = Arc::new(Mutex::new(String::new()));
        let closed = Arc::new(Mutex::new(Vec::<String>::new()));
        let (seen_in, closed_in) = (Arc::clone(&seen), Arc::clone(&closed));
        let waiting = await_prompt_answer(&pending, "h:22".into(), move |id| *seen_in.lock().unwrap() = id.to_string(),
            move |id| closed_in.lock().unwrap().push(id.to_string()), AUTH_PROMPT_TIMEOUT);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await; // dropped mid-wait, as disconnect does
        assert!(pending.lock().unwrap().is_empty());
        assert_eq!(*closed.lock().unwrap(), vec![seen.lock().unwrap().clone()]);
    }

    #[tokio::test]
    async fn timed_out_prompt_reports_closed() {
        tokio::time::pause();
        let pending: PendingPrompts = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(Mutex::new(0));
        let closed_in = Arc::clone(&closed);
        let answer = await_prompt_answer(&pending, "h:22".into(), |_| {}, move |_| *closed_in.lock().unwrap() += 1, AUTH_PROMPT_TIMEOUT).await;
        assert_eq!(answer, None);
        assert_eq!(*closed.lock().unwrap(), 1);
    }

    #[test]
    fn prompt_watch_waits_while_a_prompt_for_its_host_is_pending() {
        let keys: PendingKeys = Arc::new(Mutex::new(HashMap::new()));
        let prompts: PendingPrompts = Arc::new(Mutex::new(HashMap::new()));
        let mut watch = HostKeyPromptWatch::new(keys, "target.internal", 22);
        watch.prompts = Some(Arc::clone(&prompts));
        assert!(!watch.is_waiting());
        let (tx, _rx) = oneshot::channel();
        prompts.lock().unwrap().insert("p".into(), ("other:22".into(), tx));
        assert!(!watch.is_waiting());
        let (tx, _rx) = oneshot::channel();
        prompts.lock().unwrap().insert("q".into(), ("target.internal:22".into(), tx));
        assert!(watch.is_waiting());
    }

    #[test]
    fn host_key_prompt_watch_pauses_network_timeout_only_while_prompt_is_pending() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let watch = HostKeyPromptWatch::new(Arc::clone(&pending), "target.internal", 22);
        assert!(!watch.is_waiting());
        let (tx, _rx) = oneshot::channel();
        pending.lock().unwrap().insert("target.internal:22".to_string(), vec![("fp".to_string(), tx)]);
        assert!(watch.is_waiting());
        pending.lock().unwrap().remove("target.internal:22");
        assert!(!watch.is_waiting());
    }
}

pub const KNOWN_HOSTS_FILE: &str = "known_hosts";

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub enum StartupAction {
    Command(String),
    MissingSnippet,
}

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
    pub keepalive_secs: Option<u32>,
    pub env: Vec<(String, String)>,
    pub startup: Option<StartupAction>,
    pub forward_agent: bool,
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

/// Waiting host-key prompts per host:port; each waiter keeps the fingerprint it got.
pub type PendingKeys = Arc<Mutex<HashMap<String, Vec<(String, oneshot::Sender<bool>)>>>>;

/// Waiting login prompts by id; each remembers its host:port so the connect timeout can pause for it.
pub type PendingPrompts = Arc<Mutex<HashMap<String, (String, oneshot::Sender<Option<Vec<String>>>)>>>;

const AUTH_PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Removes the prompt on every exit (answer, timeout, dropped future); an unanswered one tells the dialog to close.
struct PromptGuard<C: FnOnce(&str)> {
    pending: PendingPrompts,
    id: String,
    answered: bool,
    closed: Option<C>,
}

impl<C: FnOnce(&str)> Drop for PromptGuard<C> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.id);
        }
        if !self.answered {
            if let Some(closed) = self.closed.take() {
                closed(&self.id);
            }
        }
    }
}

/// Registers a prompt, lets `emit` announce its id, then waits. `closed` runs if it ends unanswered.
async fn await_prompt_answer(
    pending: &PendingPrompts,
    host_port: String,
    emit: impl FnOnce(&str),
    closed: impl FnOnce(&str),
    timeout: std::time::Duration,
) -> Option<Vec<String>> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    pending.lock().ok()?.insert(id.clone(), (host_port, tx));
    let mut guard = PromptGuard { pending: Arc::clone(pending), id, answered: false, closed: Some(closed) };
    emit(&guard.id);
    let answer = tokio::time::timeout(timeout, rx).await;
    guard.answered = matches!(answer, Ok(Ok(_)));
    answer.ok()?.ok()?
}

/// Delivers a dialog answer; an unknown or expired id is ignored.
fn settle_prompt(pending: &PendingPrompts, id: &str, responses: Option<Vec<String>>) {
    let entry = pending.lock().ok().and_then(|mut map| map.remove(id));
    if let Some((_, tx)) = entry {
        let _ = tx.send(responses);
    }
}

pub(crate) fn make_prompter(
    app: tauri::AppHandle,
    pending: PendingPrompts,
    host: String,
    port: u16,
    username: String,
) -> crate::ssh_auth::Prompter {
    Arc::new(move |request: crate::ssh_auth::AuthPromptRequest| {
        let (app, pending, host, username) = (app.clone(), Arc::clone(&pending), host.clone(), username.clone());
        Box::pin(async move {
            let prompts: Vec<_> = request.prompts.iter().map(|(text, echo)| serde_json::json!({ "text": text, "echo": echo })).collect();
            await_prompt_answer(&pending, format!("{host}:{port}"), |id| {
                let _ = app.emit("ssh-auth-prompt", serde_json::json!({
                    "id": id, "host": host, "port": port, "username": username,
                    "name": request.name, "instructions": request.instructions, "prompts": prompts,
                }));
            }, |id| {
                let _ = app.emit("ssh-auth-prompt-closed", serde_json::json!({ "id": id }));
            }, AUTH_PROMPT_TIMEOUT).await
        })
    })
}

#[tauri::command]
pub fn answer_auth_prompt(id: String, responses: Option<Vec<String>>, state: tauri::State<'_, SshSessions>) -> Result<(), String> {
    settle_prompt(&state.pending_prompts, &id, responses);
    Ok(())
}

/// A waiter is approved only for the fingerprint the user was shown.
fn settle_pending(waiters: Vec<(String, oneshot::Sender<bool>)>, approved: &str, accepted: bool) {
    for (fingerprint, tx) in waiters {
        let _ = tx.send(accepted && fingerprint == approved);
    }
}

/// True when the connection failed because we refused the server's host key.
fn is_host_key_rejection(error: &str) -> bool {
    error.contains(&russh::Error::UnknownKey.to_string())
}

/// No `disconnected` for a refused key, so the terminal does not reconnect and prompt again.
fn connect_failure_events(error: &str) -> Vec<(&'static str, String)> {
    if is_host_key_rejection(error) {
        vec![("error", "Connection cancelled: host key not trusted.".to_string())]
    } else {
        vec![("error", error.to_string()), ("disconnected", String::new())]
    }
}

/// A refused destination key means the destination answered; a refused jump-host key means it was never reached.
fn ping_failure(error: crate::ssh_route::RouteError) -> Result<PingResult, String> {
    match error.hop {
        _ if !is_host_key_rejection(&error.message) => Err(error.message),
        crate::ssh_route::RouteHop::Target => Ok(PingResult { reachable: true, latency_ms: None, os: None }),
        crate::ssh_route::RouteHop::Bastion => Err("Jump host key not trusted".to_string()),
    }
}

pub struct SshSessions {
    pub sessions: Arc<Mutex<HashMap<String, SessionSlot>>>,
    pub inflight: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub pending_keys: PendingKeys,
    pub pending_prompts: PendingPrompts,
    pub known_hosts: Arc<Mutex<KnownHosts>>,
}

impl SshSessions {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            pending_keys: Arc::new(Mutex::new(HashMap::new())),
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
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
    pending_keys: PendingKeys,
    /// Set only where a user is present to answer login prompts.
    pending_prompts: Option<PendingPrompts>,
    auto_accept: bool,
    forwarded: Option<mpsc::Sender<(russh::Channel<russh::client::Msg>, russh::client::ChannelOpenHandle)>>,
    forward_bind: Option<(String, u32)>,
    require_known_host: bool,
    /// Set only on the target's interactive terminal handler.
    forward_agent: bool,
}

pub(crate) struct HostKeyPromptWatch {
    pending: PendingKeys,
    prompts: Option<PendingPrompts>,
    key: String,
}

impl HostKeyPromptWatch {
    pub(crate) fn new(
        pending: PendingKeys,
        host: &str,
        port: u16,
    ) -> Self {
        Self { pending, prompts: None, key: format!("{host}:{port}") }
    }

    pub(crate) fn is_waiting(&self) -> bool {
        self.pending.lock().map(|pending| pending.contains_key(&self.key)).unwrap_or(false)
            || self.prompts.as_ref().is_some_and(|prompts| {
                prompts.lock().map(|map| map.values().any(|(host_port, _)| *host_port == self.key)).unwrap_or(false)
            })
    }
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, session_id: &str, step: &str) {
    let _ = app.emit(
        "ssh-progress",
        serde_json::json!({ "sessionId": session_id, "step": step }),
    );
}

impl SshHandler {
    /// The prompt map and app, only for interactive handlers (the host-key rule).
    fn interactive_prompts(&self) -> Option<(tauri::AppHandle, PendingPrompts)> {
        let pending = self.pending_prompts.clone()?;
        (!self.auto_accept && !self.require_known_host).then(|| (self.app.clone(), pending))
    }

    pub(crate) fn prompt_watch(&self) -> HostKeyPromptWatch {
        let mut watch = HostKeyPromptWatch::new(Arc::clone(&self.pending_keys), &self.host, self.port);
        watch.prompts = self.pending_prompts.clone();
        watch
    }

    /// Lets this connection ask the user for login prompts.
    pub(crate) fn with_prompts(mut self, prompts: &PendingPrompts) -> Self {
        self.pending_prompts = Some(Arc::clone(prompts));
        self
    }

    pub fn new(
        host: String,
        port: u16,
        session_id: String,
        app: tauri::AppHandle,
        known_hosts: Arc<Mutex<KnownHosts>>,
        pending_keys: PendingKeys,
        auto_accept: bool,
    ) -> Self {
        // Every SSH, SFTP, forward and bastion connection builds a handler first.
        crate::logging::hide(&host);
        Self { host, port, session_id, app, known_hosts, pending_keys, pending_prompts: None, auto_accept, forwarded: None, forward_bind: None, require_known_host: false, forward_agent: false }
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

    pub(crate) fn with_forward_agent(mut self, on: bool) -> Self {
        self.forward_agent = on;
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

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !accept_agent_channel(self.forward_agent) {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        let Some(agent) = crate::ssh_agent::connect_agent(&crate::ssh_options::defaults().agent_path).await else {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(bridge(agent.into_inner(), channel.into_stream()));
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        emit_progress(&self.app, &self.session_id, "host_key");
        let fingerprint = fingerprint_of(server_public_key);
        let (host, port) = (self.host.clone(), self.port);
        let (kind, old) = {
            let mut kh = self
                .known_hosts
                .lock()
                .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?;
            let interactive = !self.auto_accept && !self.require_known_host;
            match kh.decide(&host, port, &fingerprint, interactive) {
                HostKeyDecision::Accept => return Ok(true),
                HostKeyDecision::Reject => return Ok(false),
                HostKeyDecision::Prompt(HostKeyPromptKind::New) => ("new", None),
                HostKeyDecision::Prompt(HostKeyPromptKind::Changed) => ("changed", kh.get_fingerprint(&host, port)),
            }
        };
        let host_port_key = format!("{}:{}", host, port);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending_keys
                .lock()
                .map_err(|_| std::io::Error::other("pending_keys lock poisoned"))?;
            if let Some(existing) = pending.get_mut(&host_port_key) {
                existing.push((fingerprint.clone(), tx));
            } else {
                pending.insert(host_port_key.clone(), vec![(fingerprint.clone(), tx)]);
                let _ = self.app.emit(
                    "ssh-host-key-prompt",
                    serde_json::json!({
                        "kind": kind,
                        "host": host,
                        "port": port,
                        "keyType": server_public_key.algorithm().as_str(),
                        "fingerprint": fingerprint,
                        "oldFingerprint": old,
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
    crate::logging::hide(&config.username);
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "resolving");
    }
    let addr = resolve_addr(&config.host, config.port).await?;
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "connecting");
    }
    let socket = tokio::time::timeout(
        crate::ssh_options::connect_timeout(&crate::ssh_options::defaults()),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map_err(|_| format!("connection timeout to {}:{}", config.host, config.port))?
    .map_err(|e| format!("connect {}:{}: {e}", config.host, config.port))?;
    authenticate_over_stream(handler, config, socket, progress).await
}

/// Ping and the OS probe (auto_accept without require_known_host) never touch the agent;
/// port forwards (auto_accept + require_known_host) do.
fn uses_agent(auto_accept: bool, require_known_host: bool) -> bool {
    !auto_accept || require_known_host
}

pub(crate) async fn authenticate_over_stream<R>(
    handler: SshHandler,
    config: &SshConfig,
    stream: R,
    progress: Option<(&tauri::AppHandle, &str)>,
) -> Result<russh::client::Handle<SshHandler>, String>
where R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let client_config = Arc::new(crate::ssh_options::client_config(
        &crate::ssh_options::defaults(),
        config.keepalive_secs,
    ));
    let use_agent = uses_agent(handler.auto_accept, handler.require_known_host);
    let prompter = handler.interactive_prompts();
    let mut session = russh::client::connect_stream(client_config, stream, handler)
        .await
        .map_err(|e| format!("ssh handshake {}:{}: {e}", config.host, config.port))?;
    if let Some((app, sid)) = progress {
        emit_progress(app, sid, "authenticating");
    }

    let mut agent = if use_agent {
        crate::ssh_agent::connect_agent(&crate::ssh_options::defaults().agent_path).await
    } else {
        None
    };
    let prompter = prompter.map(|(app, pending)| make_prompter(app, pending, config.host.clone(), config.port, config.username.clone()));
    let ctx = crate::ssh_auth::LoginContext { agent: agent.as_mut(), prompter };
    crate::ssh_auth::login(&mut session, config, ctx).await?;
    Ok(session)
}

async fn probe_os(
    app: tauri::AppHandle,
    session_id: String,
    config: &SshConfig,
    known_hosts: Arc<Mutex<KnownHosts>>,
    pending_keys: PendingKeys,
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
                "uname -s; echo __SHETU_OS_RELEASE__; cat /etc/os-release 2>/dev/null; cat /usr/lib/os-release 2>/dev/null",
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
        let (uname, os_release) = match out.split_once("__SHETU_OS_RELEASE__") {
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
    pending_keys: PendingKeys,
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
        channel.exec(true, "uname -s; echo __SHETU_OS_RELEASE__; cat /etc/os-release 2>/dev/null; cat /usr/lib/os-release 2>/dev/null").await.ok()?;
        let mut out = String::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        let (uname, os_release) = out.split_once("__SHETU_OS_RELEASE__")?;
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
    allow_agent_forwarding: Option<bool>,
    db: tauri::State<'_, crate::db::LocalDb>,
    crypto: tauri::State<'_, crate::CryptoState>,
    state: tauri::State<'_, SshSessions>,
) -> Result<(), String> {
    let mut route = crate::ssh_route::resolve_saved_route(&db, &crypto, &host_id)?;
    let mut config = route.target.clone();
    // Gates both the handler flag and the agent_forward request in run_connect_session.
    config.forward_agent = agent_forwarding_on(config.forward_agent, allow_agent_forwarding);
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

const STARTUP_MISSING_NOTICE: &str = "\r\n[Startup snippet not found]\r\n";
/// Writer reports `true` when a write failed (transport lost); a dropped sender
/// (user disconnect) or `false` (input channel closed) is not a loss.
fn close_reason_is_lost<E>(reason: Result<bool, E>) -> bool {
    matches!(reason, Ok(true))
}

const CONNECTION_LOST_NOTICE: &str = "\r\n[Connection lost]\r\n";

pub(crate) const NO_AGENT_NOTICE: &str = "\r\n[Agent forwarding unavailable: no SSH agent found]\r\n";

/// Pipes `a` and `b` until either direction ends, then drops both. The agent protocol is
/// request/response, and a Windows named pipe never sees EOF from `copy_bidirectional`.
async fn bridge<A, B>(a: A, b: B)
where
    A: tokio::io::AsyncRead + tokio::io::AsyncWrite,
    B: tokio::io::AsyncRead + tokio::io::AsyncWrite,
{
    let ((mut ar, mut aw), (mut br, mut bw)) = (tokio::io::split(a), tokio::io::split(b));
    // Errors just end the bridge; the data is never logged.
    tokio::select! {
        _ = tokio::io::copy(&mut ar, &mut bw) => {}
        _ = tokio::io::copy(&mut br, &mut aw) => {}
    }
}

/// The synced host flag alone never forwards: this device must have allowed it too.
fn agent_forwarding_on(forward_agent: bool, allowed_on_device: Option<bool>) -> bool {
    forward_agent && allowed_on_device == Some(true)
}

/// Agent channels are only served when the user turned forwarding on for this session.
fn accept_agent_channel(forward_agent: bool) -> bool {
    forward_agent
}

pub(crate) fn startup_bytes(command: &str) -> Vec<u8> {
    let mut b = command.as_bytes().to_vec();
    if !command.ends_with('\n') {
        b.push(b'\n');
    }
    b
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
    let pending_prompts = Arc::clone(&state.pending_prompts);
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
        ).with_prompts(&pending_prompts).with_forward_agent(config.forward_agent);

        let routed = if let Some(ref route) = route {
            let bastion_config = route.bastion.as_ref().unwrap_or(&route.target);
            let bastion_handler = SshHandler::new(bastion_config.host.clone(), bastion_config.port, session_id.clone(), app_handle.clone(), Arc::clone(&known_hosts), Arc::clone(&pending_keys), false).with_prompts(&pending_prompts);
            crate::ssh_route::connect_saved_route(route, handler, bastion_handler, Some((&app_handle, &session_id))).await.map_err(String::from)
        } else {
            connect_authenticated(handler, &config, Some((&app_handle, &session_id))).await
                .map(|target| crate::ssh_route::RouteConnection { target, bastion: None })
        };
        let connection = match routed {
            Ok(connection) => connection,
            Err(e) => {
                for (type_, data) in connect_failure_events(&e) {
                    emit(&app_handle, type_, &data);
                }
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
        for (name, value) in &config.env {
            let _ = channel.set_env(false, name.as_str(), value.as_str()).await;
        }
        if let Err(e) = channel
            .request_pty(true, &crate::ssh_options::defaults().term, cols, rows, 0, 0, &[])
            .await
        {
            emit(&app_handle, "error", &e.to_string());
            emit(&app_handle, "disconnected", "");
            return;
        }
        if config.forward_agent {
            if crate::ssh_agent::connect_agent(&crate::ssh_options::defaults().agent_path).await.is_none() {
                emit(&app_handle, "output", NO_AGENT_NOTICE);
            } else if channel.agent_forward(false).await.is_err() {
                emit(&app_handle, "output", NO_AGENT_NOTICE);
            }
        }
        if let Err(e) = channel.request_shell(true).await {
            emit(&app_handle, "error", &e.to_string());
            emit(&app_handle, "disconnected", "");
            return;
        }

        let (mut read_half, write_half) = channel.split();
        let (tx, rx) = mpsc::channel::<SessionCmd>(32);
        let (close_tx, close_rx) = oneshot::channel::<bool>();
        let startup_tx = tx.clone();
        let writer_handle = tokio::spawn(async move {
            let mut close_tx = Some(close_tx);
            let mut rx = rx;
            let mut write_failed = false;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    SessionCmd::Input(bytes) => {
                        if let Err(_) = write_half.data_bytes(bytes).await {
                            write_failed = true;
                            break;
                        }
                    }
                    SessionCmd::Resize(cols, rows) => {
                        if let Err(_) = write_half.window_change(cols, rows, 0, 0).await {
                            write_failed = true;
                            break;
                        }
                    }
                }
            }
            if let Some(tx) = close_tx.take() {
                let _ = tx.send(write_failed);
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

        match &config.startup {
            Some(StartupAction::Command(c)) => {
                let _ = startup_tx.send(SessionCmd::Input(startup_bytes(c))).await;
            }
            Some(StartupAction::MissingSnippet) => emit(&app_handle, "output", STARTUP_MISSING_NOTICE),
            None => {}
        }
        drop(startup_tx);

        let mut pending: Vec<u8> = Vec::new();
        let mut close_rx = close_rx;
        let mut lost = false;
        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    let Some(msg) = msg else { lost = true; break };
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
                reason = &mut close_rx => { lost = close_reason_is_lost(reason); break }
            }
        }
        if !pending.is_empty() {
            emit(&app_handle, "output", &String::from_utf8_lossy(&pending));
        }
        // Remove session slot and abort writer
        if let Some(slot) = sessions.lock().ok().and_then(|mut g| g.remove(&session_id)) {
            slot.writer_handle.abort();
        }
        if lost {
            emit(&app_handle, "output", CONNECTION_LOST_NOTICE);
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
    fingerprint: String,
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
        settle_pending(senders, &fingerprint, accepted);
    }
    Ok(())
}

#[tauri::command]
pub fn set_trust_new_hosts(enabled: bool, state: tauri::State<'_, SshSessions>) -> Result<(), String> {
    state.known_hosts.lock().map_err(|e| e.to_string())?.trust_new_hosts = enabled;
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
            Ok(Err(error)) => return ping_failure(error),
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

fn load_startup(
    db: &crate::db::LocalDb,
    crypto: &crate::CryptoState,
    vault_id: &str,
    startup: &serde_json::Value,
) -> Option<StartupAction> {
    if let Some(cmd) = startup["command"].as_str() {
        return (!cmd.trim().is_empty()).then(|| StartupAction::Command(cmd.to_string()));
    }
    let id = startup["snippetId"].as_str()?;
    let command = (|| {
        let row = crate::db::get_sync_row(db, crate::db::Table::Snippets, id).ok()??;
        if row.deleted_at.is_some() || row.vault_id != vault_id {
            return None;
        }
        let session = crypto.session.lock().ok()?;
        let plain = crate::team_keys::decrypt_row_secret(db, &session, &row.data, "snippets", &row.vault_id).ok()?;
        let v: serde_json::Value = serde_json::from_str(&plain).ok()?;
        v["command"].as_str().filter(|c| !c.trim().is_empty()).map(String::from)
    })();
    Some(command.map_or(StartupAction::MissingSnippet, StartupAction::Command))
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
        keepalive_secs: payload["keepaliveSecs"]
            .as_f64()
            .map(|n| crate::ssh_options::clamp_keepalive(n as i64)),
        forward_agent: payload["forwardAgent"].as_bool() == Some(true),
        env: payload["env"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| {
                        let name = r["name"].as_str()?;
                        let mut ch = name.chars();
                        let ok = ch.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                            && ch.all(|c| c.is_ascii_alphanumeric() || c == '_');
                        ok.then(|| Some((name.to_string(), r["value"].as_str()?.to_string())))
                            .flatten()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        startup: load_startup(db, crypto, &row.vault_id, &payload["startup"]),
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

#[cfg(test)]
mod agent_use_tests {
    use super::{agent_forwarding_on, uses_agent};

    #[test]
    fn forwarding_needs_host_flag_and_device_consent() {
        assert!(!agent_forwarding_on(true, None));
        assert!(!agent_forwarding_on(true, Some(false)));
        assert!(!agent_forwarding_on(false, Some(true)));
        assert!(agent_forwarding_on(true, Some(true)));
    }

    #[test]
    fn only_ping_and_os_probe_skip_the_agent() {
        // (auto_accept, require_known_host)
        assert!(!uses_agent(true, false), "ping / OS probe");
        assert!(uses_agent(true, true), "port forward");
        assert!(uses_agent(false, false), "terminal / SFTP");
    }
}
