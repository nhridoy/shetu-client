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
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.get_mut(id) {
                entry.status = status.clone();
                let _ = entry.app.emit(
                    "forward-status",
                    serde_json::json!({ "id": id, "status": status }),
                );
            }
        }
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
                if matches!(
                    entry.status,
                    ForwardStatus::Starting | ForwardStatus::Active
                ) {
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
                tokio::spawn(async move {
                    let outcome = task.await;
                    if !cancel.is_cancelled() {
                        cancel.cancel();
                        if let Ok(mut map) = entries.lock() {
                            if let Some(entry) = map.get_mut(&id) {
                                let status = ForwardStatus::Failed(
                                    outcome
                                        .err()
                                        .unwrap_or_else(|| "SSH connection closed".into()),
                                );
                                entry.status = status.clone();
                                let _ = entry.app.emit(
                                    "forward-status",
                                    serde_json::json!({ "id": id, "status": status }),
                                );
                            }
                        }
                    }
                });
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
            bastion_config.host.clone(), bastion_config.port,
            format!("forward:{}", definition.id), app.clone(),
            Arc::clone(&ssh.known_hosts), Arc::clone(&ssh.pending_keys), true,
        ).require_known_host();
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
                        ended = async { match &mut bastion { Some(handle) => Some(handle.await), None => std::future::pending().await } } => return Err(format!("Bastion connection ended: {ended:?}")),
                        ended = &mut session => return Err(format!("SSH connection ended: {ended:?}")),
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
                                    eprintln!("forward channel open failed: {error}");
                                },
                            }
                        }
                    }
                }
            } else if let Some((address, port)) = remote_bind {
                loop {
                    let received = tokio::select! {
                        _ = stop.cancelled() => break,
                        ended = async { match &mut bastion { Some(handle) => Some(handle.await), None => std::future::pending().await } } => return Err(format!("Bastion connection ended: {ended:?}")),
                        ended = &mut session => return Err(format!("SSH connection ended: {ended:?}")),
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

impl Drop for ForwardingState {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopped_is_default_status() {
        let state = ForwardingState::new();
        assert_eq!(state.status("unknown"), ForwardStatus::Stopped);
    }
}
