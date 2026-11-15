use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::model::{ForwardDefinition, ForwardMode, ForwardStatus};
use super::{relay, socks};
use crate::ssh::{SshHandler, SshSessions};

struct Running {
    host_id: String,
    owner_pane_id: String,
    status: ForwardStatus,
    cancel: CancellationToken,
    app: tauri::AppHandle,
}

#[derive(Default)]
pub struct ForwardingState {
    entries: Arc<Mutex<HashMap<String, Running>>>,
}

impl ForwardingState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self, id: &str) -> ForwardStatus {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(id).map(|entry| entry.status.clone()))
            .unwrap_or(ForwardStatus::Stopped)
    }

    fn set_status(&self, id: &str, status: ForwardStatus) {
        update_status(&self.entries, id, status);
    }

    pub fn stop(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.remove(id) {
                entry.cancel.cancel();
                let _ = entry.app.emit(
                    "forward-status",
                    serde_json::json!({ "id": id, "status": ForwardStatus::Stopped }),
                );
            }
        }
    }

    pub fn stop_owner(&self, pane: &str) {
        let ids = self.matching_ids(|entry| entry.owner_pane_id == pane);
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn stop_host(&self, host: &str) {
        let ids = self.matching_ids(|entry| entry.host_id == host);
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn stop_all(&self) {
        let ids = self.matching_ids(|_| true);
        for id in ids {
            self.stop(&id);
        }
    }

    fn matching_ids(&self, predicate: impl Fn(&Running) -> bool) -> Vec<String> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(_, value)| predicate(value))
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn start(
        &self,
        definition: ForwardDefinition,
        owner_pane_id: String,
        db: &crate::db::LocalDb,
        crypto: &crate::CryptoState,
        app: &tauri::AppHandle,
        ssh: &SshSessions,
    ) -> Result<ForwardStatus, String> {
        let id = definition.id.clone();
        let cancel = CancellationToken::new();
        {
            let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
            if let Some(entry) = entries.get(&id) {
                if !should_auto_start(&entry.status) {
                    return Err("Forward is already running".into());
                }
            }
            entries.insert(
                id.clone(),
                Running {
                    host_id: definition.host_id.clone(),
                    owner_pane_id,
                    status: ForwardStatus::Starting,
                    cancel: cancel.clone(),
                    app: app.clone(),
                },
            );
        }
        self.set_status(&id, ForwardStatus::Starting);
        let result = self
            .prepare(&definition, db, crypto, app, ssh, cancel.clone())
            .await;
        match result {
            Ok(task) => {
                if cancel.is_cancelled() {
                    return Err("Forward was stopped while starting".into());
                }
                self.set_status(&id, ForwardStatus::Active);
                let entries = Arc::clone(&self.entries);
                let app = app.clone();
                let stop = cancel.clone();
                // Each reconnect attempt reads the app's own state, so the task needs no borrows.
                let forward_id = id.clone();
                let attempt = move || {
                    let (app, id, stop) = (app.clone(), forward_id.clone(), stop.clone());
                    async move {
                        use tauri::Manager;
                        let state = app.state::<ForwardingState>();
                        let db = app.state::<crate::db::LocalDb>();
                        let crypto = app.state::<crate::CryptoState>();
                        let ssh = app.state::<SshSessions>();
                        // Re-read it: edited elsewhere uses the new settings; deleted stops for good.
                        let current = {
                            let session = crypto.session.lock().map_err(|e| e.to_string())?;
                            super::storage::get_live(&db, &session, &id)?
                        };
                        let Some(definition) = current else {
                            state.stop(&id);
                            return Err("Forward was deleted".to_string());
                        };
                        state
                            .prepare(&definition, &db, &crypto, &app, &ssh, stop)
                            .await
                            .map(|run| Box::pin(run) as RunFuture)
                    }
                };
                let own_run = cancel.clone();
                tokio::spawn(supervise(
                    cancel,
                    Box::pin(task) as RunFuture,
                    attempt,
                    // A stopped run must not write over a newer run of the same forward.
                    move |status| {
                        if !own_run.is_cancelled() {
                            update_status(&entries, &id, status)
                        }
                    },
                ));
                Ok(ForwardStatus::Active)
            }
            Err(error) => {
                self.set_status(&id, ForwardStatus::Failed(error.clone()));
                Err(error)
            }
        }
    }

    async fn prepare(
        &self,
        definition: &ForwardDefinition,
        db: &crate::db::LocalDb,
        crypto: &crate::CryptoState,
        app: &tauri::AppHandle,
        ssh: &SshSessions,
        stop: CancellationToken,
    ) -> Result<impl std::future::Future<Output = Result<(), String>> + Send + 'static, String>
    {
        let route = crate::ssh_route::resolve_saved_route(db, crypto, &definition.host_id)?;
        let config = &route.target;
        let listener = if definition.mode != ForwardMode::Remote {
            let port = definition.local_port.ok_or("Local port missing")?;
            Some(
                TcpListener::bind(("127.0.0.1", port))
                    .await
                    .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?,
            )
        } else {
            None
        };
        let (tx, mut rx) = mpsc::channel(64);
        let mut handler = SshHandler::new(
            config.host.clone(),
            config.port,
            format!("forward:{}", definition.id),
            app.clone(),
            Arc::clone(&ssh.known_hosts),
            Arc::clone(&ssh.pending_keys),
            true,
        )
        .require_known_host();
        if definition.mode == ForwardMode::Remote {
            handler = handler.with_forwarded_channels(
                tx,
                definition
                    .remote_bind_address
                    .clone()
                    .ok_or("Remote bind address missing")?,
                definition.remote_port.ok_or("Remote port missing")? as u32,
            );
        }
        let bastion_config = route.bastion.as_ref().unwrap_or(config);
        let bastion_handler = SshHandler::new(
            bastion_config.host.clone(),
            bastion_config.port,
            format!("forward:{}", definition.id),
            app.clone(),
            Arc::clone(&ssh.known_hosts),
            Arc::clone(&ssh.pending_keys),
            true,
        )
        .require_known_host();
        let connection = tokio::select! {
            _ = stop.cancelled() => return Err("Forward stopped".into()),
            result = crate::ssh_route::connect_saved_route(&route, handler, bastion_handler, None) => result?,
        };
        let mut session = connection.target;
        let mut bastion = connection.bastion;
        let remote_bind = if definition.mode == ForwardMode::Remote {
            let address = definition
                .remote_bind_address
                .clone()
                .ok_or("Remote bind address missing")?;
            let port = definition.remote_port.ok_or("Remote port missing")?;
            tokio::select! {
                _ = stop.cancelled() => return Err("Forward stopped".into()),
                result = session.tcpip_forward(address.clone(), port as u32) => result.map_err(|e| format!("remote forwarding refused: {e}"))?,
            };
            Some((address, port))
        } else {
            None
        };
        let definition = definition.clone();
        Ok(async move {
            if let Some(listener) = listener {
                let (ready_tx, mut ready_rx) =
                    mpsc::channel::<(TcpStream, std::net::SocketAddr, String, u16)>(64);
                loop {
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = async { match &mut bastion { Some(handle) => Some(handle.await), None => std::future::pending().await } } => return Err("Jump host connection closed".to_string()),
                        _ = &mut session => return Err("SSH connection closed".to_string()),
                        accepted = listener.accept() => {
                            let (mut stream, peer) = accepted.map_err(|e| format!("accept: {e}"))?;
                            let tx = ready_tx.clone();
                            let mode = definition.mode;
                            let target = definition.destination_host.clone();
                            let target_port = definition.destination_port;
                            let child = stop.child_token();
                            tokio::spawn(async move {
                                let target = if mode == ForwardMode::Dynamic {
                                    let handshake = tokio::select! {
                                        _ = child.cancelled() => return,
                                        result = socks::read_connect(&mut stream) => result,
                                    };
                                    match handshake {
                                        Ok(target) => target,
                                        Err(error) => {
                                            if error != socks::SocksError::UnsupportedAuth {
                                                let _ = socks::reply(&mut stream, error.reply_code()).await;
                                            }
                                            return;
                                        }
                                    }
                                } else {
                                    let (Some(host), Some(port)) = (target, target_port) else { return; };
                                    (host, port)
                                };
                                tokio::select! {
                                    _ = child.cancelled() => {},
                                    _ = tx.send((stream, peer, target.0, target.1)) => {},
                                }
                            });
                        }
                        Some((mut stream, peer, host, port)) = ready_rx.recv() => {
                            let channel = tokio::select! {
                                _ = stop.cancelled() => break,
                                result = session.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32) => result,
                            };
                            match channel {
                                Ok(channel) => {
                                    if definition.mode == ForwardMode::Dynamic { let _ = socks::reply(&mut stream, 0).await; }
                                    tokio::spawn(relay::bridge(stream, channel, stop.child_token()));
                                },
                                Err(error) => {
                                    if definition.mode == ForwardMode::Dynamic { let _ = socks::reply(&mut stream, socks::SocksError::ConnectFailed.reply_code()).await; }
                                    log::warn!("forward channel open failed: {error}");
                                },
                            }
                        }
                    }
                }
            } else if let Some((address, port)) = remote_bind {
                loop {
                    let received = tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = async { match &mut bastion { Some(handle) => Some(handle.await), None => std::future::pending().await } } => return Err("Jump host connection closed".to_string()),
                        _ = &mut session => return Err("SSH connection closed".to_string()),
                        received = rx.recv() => received,
                    };
                    let Some((channel, reply)) = received else {
                        return Err("SSH forwarding receiver closed".into());
                    };
                    let destination = definition
                        .destination_host
                        .clone()
                        .ok_or("Destination missing")?;
                    let destination_port = definition.destination_port.ok_or("Port missing")?;
                    let child = stop.child_token();
                    tokio::spawn(async move {
                        let connected = tokio::select! {
                            _ = child.cancelled() => {
                                reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
                                return;
                            }
                            result = tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                TcpStream::connect((destination.as_str(), destination_port)),
                            ) => result,
                        };
                        match connected {
                            Ok(Ok(stream)) => {
                                reply.accept().await;
                                let _ = relay::bridge(stream, channel, child).await;
                            }
                            _ => {
                                let _ =
                                    reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                            }
                        }
                    });
                }
                let _ = session.cancel_tcpip_forward(address, port as u32).await;
            }
            Ok(())
        })
    }
}

type RunFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

fn update_status(entries: &Mutex<HashMap<String, Running>>, id: &str, status: ForwardStatus) {
    if let Ok(mut entries) = entries.lock() {
        // A stopped forward has no entry: late status from its task is dropped.
        if let Some(entry) = entries.get_mut(id) {
            entry.status = status.clone();
            let _ = entry.app.emit(
                "forward-status",
                serde_json::json!({ "id": id, "status": status }),
            );
        }
    }
}

/// Wait before reconnect attempt `n` (0-based): 1, 2, 5, 10, then 30 seconds.
pub fn reconnect_delay(attempt: u32) -> std::time::Duration {
    const STEPS: [u64; 4] = [1, 2, 5, 10];
    std::time::Duration::from_secs(STEPS.get(attempt as usize).copied().unwrap_or(30))
}

/// Failures a retry can't fix: retrying a rejected login every 30 s can get the IP banned.
pub fn is_permanent_failure(error: &str) -> bool {
    error.contains("authentication rejected")
        || error.contains(crate::ssh_auth::NON_INTERACTIVE)
        || error.contains(crate::ssh_auth::CANCELLED)
        || crate::ssh::is_host_key_rejection(error)
        || error.contains("key not trusted")
        || error.contains("No username set")
        || error.contains("does not exist")
        || error.contains("Forward was deleted")
}

/// Auto-start leaves alone a forward that is already up or on its way.
pub fn should_auto_start(status: &ForwardStatus) -> bool {
    matches!(status, ForwardStatus::Stopped | ForwardStatus::Failed(_))
}

/// Keeps a started forward alive: when its connection ends without a stop, retries with
/// back-off until a new connection is up again, or until `stop` is cancelled.
pub(crate) async fn supervise<A, Fut, R>(
    stop: CancellationToken,
    first: R,
    mut attempt: A,
    mut on_status: impl FnMut(ForwardStatus),
) where
    A: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<R, String>>,
    R: std::future::Future<Output = Result<(), String>> + Unpin,
{
    let mut run = first;
    loop {
        let outcome = tokio::select! {
            _ = stop.cancelled() => return,
            outcome = &mut run => outcome,
        };
        let mut reason = outcome
            .err()
            .unwrap_or_else(|| "SSH connection closed".into());
        let mut tries = 0;
        run = loop {
            on_status(ForwardStatus::Reconnecting(reason.clone()));
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tokio::time::sleep(reconnect_delay(tries)) => {}
            }
            tries += 1;
            let result = tokio::select! {
                _ = stop.cancelled() => return,
                result = attempt() => result,
            };
            match result {
                Ok(next) => break next,
                Err(error) if is_permanent_failure(&error) => {
                    on_status(ForwardStatus::Failed(error));
                    return;
                }
                Err(error) => reason = error,
            }
        };
        on_status(ForwardStatus::Active);
    }
}

impl Drop for ForwardingState {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Run = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
    fn ended(err: &str) -> Run {
        let err = err.to_string();
        Box::pin(async move { Err(err) })
    }
    fn forever() -> Run {
        Box::pin(std::future::pending())
    }

    #[test]
    fn reconnect_delays_back_off_then_hold_at_30s() {
        let secs: Vec<u64> = (0..7).map(|n| reconnect_delay(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 5, 10, 30, 30, 30]);
    }

    #[test]
    fn reconnecting_serializes_with_its_reason() {
        let v = serde_json::to_value(ForwardStatus::Reconnecting("SSH connection ended".into()))
            .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"state": "reconnecting", "error": "SSH connection ended"})
        );
    }

    #[test]
    fn terminal_trigger_skips_running_forwards() {
        assert!(should_auto_start(&ForwardStatus::Stopped));
        assert!(should_auto_start(&ForwardStatus::Failed("x".into())));
        for running in [
            ForwardStatus::Starting,
            ForwardStatus::Active,
            ForwardStatus::Reconnecting("x".into()),
        ] {
            assert!(!should_auto_start(&running));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_connection_reconnects_after_the_delay() {
        let cancel = CancellationToken::new();
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (s, a) = (statuses.clone(), attempts.clone());
        let task = tokio::spawn(supervise(
            cancel.clone(),
            ended("SSH connection ended"),
            move || {
                let n = a.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err("refused".to_string())
                    } else {
                        Ok(forever())
                    }
                }
            },
            move |status| s.lock().unwrap().push(status),
        ));
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        cancel.cancel();
        task.await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            *statuses.lock().unwrap(),
            vec![
                ForwardStatus::Reconnecting("SSH connection ended".into()),
                ForwardStatus::Reconnecting("refused".into()),
                ForwardStatus::Active,
            ]
        );
    }

    #[test]
    fn login_and_host_key_failures_are_permanent() {
        let host_key = format!("destination connection: ssh handshake web:22: {}", russh::Error::UnknownKey);
        for permanent in [
            "authentication rejected",
            host_key.as_str(),
            crate::ssh_auth::NON_INTERACTIVE,
            "No username set for this host",
            "Forward was deleted",
        ] {
            assert!(is_permanent_failure(permanent), "{permanent}");
        }
        for transient in ["SSH connection closed", "connect web:22: Connection refused", "timed out"] {
            assert!(!is_permanent_failure(transient), "{transient}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_permanent_failure_stops_retrying() {
        let cancel = CancellationToken::new();
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (s, a) = (statuses.clone(), attempts.clone());
        let task = tokio::spawn(supervise(
            cancel.clone(),
            ended("SSH connection closed"),
            move || {
                a.fetch_add(1, Ordering::SeqCst);
                async { Err::<Run, String>("authentication rejected".into()) }
            },
            move |status| s.lock().unwrap().push(status),
        ));
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        assert!(task.is_finished(), "a rejected login must not be retried");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(
            statuses.lock().unwrap().last(),
            Some(&ForwardStatus::Failed("authentication rejected".into()))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_reconnecting() {
        let cancel = CancellationToken::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let a = attempts.clone();
        let task = tokio::spawn(supervise(
            cancel.clone(),
            ended("dropped"),
            move || {
                a.fetch_add(1, Ordering::SeqCst);
                async { Err::<Run, String>("refused".into()) }
            },
            |_| {},
        ));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        cancel.cancel();
        task.await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        // Stopped during the first wait: no attempt ever ran, and none run later.
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stopped_is_default_status() {
        let state = ForwardingState::new();
        assert_eq!(state.status("unknown"), ForwardStatus::Stopped);
    }
}
