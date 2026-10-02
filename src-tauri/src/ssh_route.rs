use crate::ssh::SshHandler;
use crate::{
    db::{self, LocalDb, Table},
    ssh::{self, SshConfig},
    CryptoState,
};

pub struct RouteConnection {
    pub target: russh::client::Handle<SshHandler>,
    pub bastion: Option<russh::client::Handle<SshHandler>>,
}

async fn open_target_channel<H: russh::client::Handler>(
    bastion: &russh::client::Handle<H>,
    target_host: &str,
    target_port: u16,
) -> Result<russh::ChannelStream<russh::client::Msg>, String> {
    bastion
        .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
        .await
        .map(|channel| channel.into_stream())
        .map_err(|error| format!("destination channel through bastion: {error}"))
}

pub async fn connect_saved_route(
    route: &SavedRoute,
    target_handler: SshHandler,
    bastion_handler: SshHandler,
    progress: Option<(&tauri::AppHandle, &str)>,
) -> Result<RouteConnection, String> {
    let Some(bastion_config) = route.bastion.as_ref() else {
        let target = ssh::connect_authenticated(target_handler, &route.target, progress).await?;
        return Ok(RouteConnection {
            target,
            bastion: None,
        });
    };
    let bastion = ssh::connect_authenticated(bastion_handler, bastion_config, progress)
        .await
        .map_err(|error| format!("bastion connection: {error}"))?;
    let channel = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        open_target_channel(&bastion, &route.target.host, route.target.port),
    )
    .await
    .map_err(|_| "destination channel through bastion timed out".to_string())??;
    let prompt_watch = target_handler.prompt_watch();
    let mut connection = Box::pin(ssh::authenticate_over_stream(
        target_handler,
        &route.target,
        channel,
        progress,
    ));
    let mut network_wait = std::time::Duration::ZERO;
    let target = loop {
        tokio::select! {
            result = &mut connection => break result.map_err(|error| format!("destination connection: {error}"))?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if !prompt_watch.is_waiting() {
                    network_wait += std::time::Duration::from_millis(100);
                    if network_wait >= std::time::Duration::from_secs(10) {
                        return Err("destination SSH handshake through bastion timed out".to_string());
                    }
                }
            }
        }
    };
    Ok(RouteConnection {
        target,
        bastion: Some(bastion),
    })
}

#[derive(Clone)]
pub struct SavedRoute {
    pub target_id: String,
    pub target: SshConfig,
    pub bastion_id: Option<String>,
    pub bastion: Option<SshConfig>,
}

fn jump_host_id(
    db: &LocalDb,
    crypto: &CryptoState,
    row: &db::SyncRow,
) -> Result<Option<String>, String> {
    let keys = crypto.session.lock().map_err(|e| e.to_string())?;
    let plaintext =
        crate::team_keys::decrypt_row_secret(db, &keys, &row.data, "hosts", &row.vault_id)?;
    let payload: serde_json::Value =
        serde_json::from_str(&plaintext).map_err(|_| "invalid saved host payload")?;
    match payload.get("jumpHostId") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(id)) if !id.is_empty() => Ok(Some(id.clone())),
        _ => Err("invalid bastion reference".into()),
    }
}

pub fn resolve_saved_route(
    db: &LocalDb,
    crypto: &CryptoState,
    host_id: &str,
) -> Result<SavedRoute, String> {
    let row = db::get_sync_row(db, Table::Hosts, host_id)?
        .filter(|row| row.deleted_at.is_none())
        .ok_or("destination host unavailable")?;
    let target = ssh::load_host_config(db, crypto, host_id)?;
    let Some(bastion_id) = jump_host_id(db, crypto, &row)? else {
        return Ok(SavedRoute {
            target_id: host_id.into(),
            target,
            bastion_id: None,
            bastion: None,
        });
    };
    if bastion_id == host_id {
        return Err("host cannot use itself as a bastion".into());
    }
    let bastion_row = db::get_sync_row(db, Table::Hosts, &bastion_id)?
        .filter(|candidate| candidate.deleted_at.is_none())
        .ok_or("selected bastion is unavailable")?;
    if bastion_row.vault_id != row.vault_id {
        return Err("bastion must be in the same vault".into());
    }
    if jump_host_id(db, crypto, &bastion_row)?.is_some() {
        return Err("bastion cannot use another jump host".into());
    }
    let bastion = ssh::load_host_config(db, crypto, &bastion_id)?;
    Ok(SavedRoute {
        target_id: host_id.into(),
        target,
        bastion_id: Some(bastion_id),
        bastion: Some(bastion),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto, db, CryptoState};
    use std::sync::Arc;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct TestBastion;

    impl russh::server::Handler for TestBastion {
        type Error = russh::Error;
        async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            _: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: russh::server::ChannelOpenHandle,
            _: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            match tokio::net::TcpStream::connect(("127.0.0.1", port as u16)).await {
                Ok(mut socket) => {
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
                    });
                }
                Err(_) => {
                    reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                }
            }
            Ok(())
        }
    }

    struct TestClient;
    impl russh::client::Handler for TestClient {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &russh::keys::ssh_key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn direct_tcp_channel_carries_bytes_through_bastion() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        let target_task = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.unwrap();
            let mut buffer = [0u8; 4];
            socket.read_exact(&mut buffer).await.unwrap();
            socket.write_all(&buffer).await.unwrap();
        });
        let bastion = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bastion_addr = bastion.local_addr().unwrap();
        let mut config = russh::server::Config::default();
        config.keys.push(
            russh::keys::ssh_key::PrivateKey::random(
                &mut rand10::rng(),
                russh::keys::ssh_key::Algorithm::Ed25519,
            )
            .unwrap(),
        );
        let config = Arc::new(config);
        let bastion_task = tokio::spawn(async move {
            let (socket, _) = bastion.accept().await.unwrap();
            russh::server::run_stream(config, socket, TestBastion)
                .await
                .unwrap();
        });
        let mut client = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            bastion_addr,
            TestClient,
        )
        .await
        .unwrap();
        assert!(client.authenticate_none("user").await.unwrap().success());
        let mut stream = open_target_channel(&client, "target.internal", target_port)
            .await
            .unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut echo = [0u8; 4];
        stream.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"ping");
        target_task.await.unwrap();
        drop(stream);
        drop(client);
        bastion_task.abort();
    }

    fn fixture() -> (db::LocalDb, CryptoState, String) {
        let db = db::open(":memory:").unwrap();
        let mut keys = crypto::KeySession::new();
        crypto::generate_account_material(&mut keys).unwrap();
        (
            db,
            CryptoState {
                session: Mutex::new(keys),
            },
            uuid::Uuid::new_v4().to_string(),
        )
    }

    fn host(db: &db::LocalDb, crypto: &CryptoState, id: &str, vault: &str, jump: Option<&str>) {
        let payload = serde_json::json!({"address": format!("{id}.internal"), "port": 22, "username": "user", "jumpHostId": jump});
        let data = crypto::encrypt_secret(
            &payload.to_string(),
            "hosts",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO hosts (id, vault_id, name, data, auth_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'none', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')",
            rusqlite::params![id, vault, id, data],
        ).unwrap();
    }

    #[test]
    fn resolves_one_bastion_without_exposing_route_as_plaintext_metadata() {
        let (db, crypto, vault) = fixture();
        host(&db, &crypto, "bastion", &vault, None);
        host(&db, &crypto, "target", &vault, Some("bastion"));
        let route = resolve_saved_route(&db, &crypto, "target").unwrap();
        assert_eq!(route.target.host, "target.internal");
        assert_eq!(route.bastion.unwrap().host, "bastion.internal");
        let row = db::get_sync_row(&db, db::Table::Hosts, "target")
            .unwrap()
            .unwrap();
        assert!(!row.data.contains("bastion.internal"));
    }

    #[test]
    fn rejects_missing_cross_vault_self_and_chained_bastions() {
        let (db, crypto, vault) = fixture();
        let other = uuid::Uuid::new_v4().to_string();
        host(&db, &crypto, "missing-target", &vault, Some("gone"));
        host(&db, &crypto, "cross-target", &vault, Some("other"));
        host(&db, &crypto, "other", &other, None);
        host(&db, &crypto, "self", &vault, Some("self"));
        host(&db, &crypto, "chain", &vault, Some("self"));
        host(&db, &crypto, "chain-target", &vault, Some("chain"));
        for id in ["missing-target", "cross-target", "self", "chain-target"] {
            assert!(resolve_saved_route(&db, &crypto, id).is_err(), "{id}");
        }
    }
}
