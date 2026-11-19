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

/// Which hop of a route failed, so callers need not parse the message; also which hop a login prompt is for.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteHop {
    Bastion,
    Target,
}

#[derive(Debug)]
pub struct RouteError {
    pub hop: RouteHop,
    pub message: String,
}

impl From<RouteError> for String {
    fn from(error: RouteError) -> Self {
        error.message
    }
}

fn at(hop: RouteHop) -> impl FnOnce(String) -> RouteError {
    move |message| RouteError { hop, message }
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
) -> Result<RouteConnection, RouteError> {
    let Some(bastion_config) = route.bastion.as_ref() else {
        let target = ssh::connect_authenticated(target_handler, &route.target, progress)
            .await
            .map_err(at(RouteHop::Target))?;
        return Ok(RouteConnection {
            target,
            bastion: None,
        });
    };
    let bastion = ssh::connect_authenticated(
        bastion_handler.at_hop(RouteHop::Bastion),
        bastion_config,
        progress,
    )
    .await
    .map_err(|error| format!("bastion connection: {error}"))
    .map_err(at(RouteHop::Bastion))?;
    let connect_timeout = crate::ssh_options::connect_timeout(&crate::ssh_options::defaults());
    let channel = tokio::time::timeout(
        connect_timeout,
        open_target_channel(&bastion, &route.target.host, route.target.port),
    )
    .await
    .map_err(|_| "destination channel through bastion timed out".to_string())
    .and_then(|opened| opened)
    .map_err(at(RouteHop::Bastion))?;
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
            result = &mut connection => break result
                .map_err(|error| format!("destination connection: {error}"))
                .map_err(at(RouteHop::Target))?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if !prompt_watch.is_waiting() {
                    network_wait += std::time::Duration::from_millis(100);
                    if network_wait >= connect_timeout {
                        return Err(at(RouteHop::Target)("destination SSH handshake through bastion timed out".to_string()));
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
    resolve_saved_route_as(db, crypto, host_id, None)
}

/// `username` applies to the destination only, as in [`ssh::load_host_config_as`].
pub fn resolve_saved_route_as(
    db: &LocalDb,
    crypto: &CryptoState,
    host_id: &str,
    username: Option<&str>,
) -> Result<SavedRoute, String> {
    let row = db::get_sync_row(db, Table::Hosts, host_id)?
        .filter(|row| row.deleted_at.is_none())
        .ok_or("destination host unavailable")?;
    let target = ssh::load_host_config_as(db, crypto, host_id, username)?;
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
    let bastion =
        ssh::load_host_config(db, crypto, &bastion_id).map_err(|e| format!("Jump host: {e}"))?;
    Ok(SavedRoute {
        target_id: host_id.into(),
        target,
        bastion_id: Some(bastion_id),
        bastion: Some(bastion),
    })
}

#[cfg(test)]
pub(crate) mod tests {
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

    pub(crate) fn fixture() -> (db::LocalDb, CryptoState, String) {
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

    use crate::ssh::StartupAction;

    fn host_with(
        db: &db::LocalDb,
        crypto: &CryptoState,
        id: &str,
        vault: &str,
        payload: serde_json::Value,
    ) {
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

    fn snippet(
        db: &db::LocalDb,
        crypto: &CryptoState,
        id: &str,
        vault: &str,
        command: &str,
        deleted: bool,
    ) {
        let data = crypto::encrypt_secret(
            &serde_json::json!({"command": command}).to_string(),
            "snippets",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO snippets (id, vault_id, name, data, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?1, ?3, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', ?4)",
            rusqlite::params![id, vault, data, deleted.then_some("2026-10-03T00:00:00Z")],
        ).unwrap();
    }

    fn startup_of(startup: serde_json::Value) -> Option<StartupAction> {
        let (db, crypto, vault) = fixture();
        snippet(&db, &crypto, "s1", &vault, "htop", false);
        snippet(&db, &crypto, "s2", "other-vault", "top", false);
        snippet(&db, &crypto, "s3", &vault, "gone", true);
        snippet(
            &db,
            &crypto,
            "s4",
            &vault,
            "tail -n {{ lines }} app.log",
            false,
        );
        host_with(
            &db,
            &crypto,
            "h",
            &vault,
            serde_json::json!({"address": "a", "startup": startup}),
        );
        crate::ssh::load_host_config(&db, &crypto, "h")
            .unwrap()
            .startup
    }

    #[test]
    fn host_options_parse_keepalive_env_and_command() {
        let (db, crypto, vault) = fixture();
        host_with(
            &db,
            &crypto,
            "h",
            &vault,
            serde_json::json!({"address": "a", "keepaliveSecs": 120,
            "env": [{"name":"LANG","value":"C.UTF-8"},{"name":"1BAD","value":"x"},{"name":"OK_2","value":"y"},{"name":"NUM","value":5}],
            "startup": {"command": "tmux a"}}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(c.keepalive_secs, Some(120));
        assert_eq!(
            c.env,
            vec![
                ("LANG".to_string(), "C.UTF-8".to_string()),
                ("OK_2".to_string(), "y".to_string())
            ]
        );
        assert_eq!(c.startup, Some(StartupAction::Command("tmux a".into())));
    }

    #[test]
    fn startup_snippet_resolves_in_same_vault() {
        assert_eq!(
            startup_of(serde_json::json!({"snippetId": "s1"})),
            Some(StartupAction::Command("htop".into()))
        );
    }

    #[test]
    fn startup_snippet_in_other_vault_is_missing() {
        assert_eq!(
            startup_of(serde_json::json!({"snippetId": "s2"})),
            Some(StartupAction::MissingSnippet)
        );
    }

    #[test]
    fn startup_snippet_with_variables_is_not_sent() {
        // Nothing can fill {{lines}} at connect time; typing the braces would run junk.
        assert_eq!(
            startup_of(serde_json::json!({"snippetId": "s4"})),
            Some(StartupAction::SnippetHasVariables)
        );
    }

    #[test]
    fn deleted_or_absent_snippet_is_missing() {
        for id in ["s3", "nope"] {
            assert_eq!(
                startup_of(serde_json::json!({"snippetId": id})),
                Some(StartupAction::MissingSnippet),
                "{id}"
            );
        }
    }

    #[test]
    fn host_options_tolerate_junk_payload() {
        let (db, crypto, vault) = fixture();
        host_with(
            &db,
            &crypto,
            "h",
            &vault,
            serde_json::json!({"address": "a", "keepaliveSecs": "abc", "env": "x", "startup": {}}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(c.keepalive_secs, None);
        assert!(c.env.is_empty());
        assert_eq!(c.startup, None);
        assert!(resolve_saved_route(&db, &crypto, "h").is_ok());
        assert_eq!(startup_of(serde_json::json!({"command": "  "})), None);
    }

    #[test]
    fn legacy_payload_has_no_options() {
        let (db, crypto, vault) = fixture();
        host(&db, &crypto, "h", &vault, None);
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (c.keepalive_secs, c.env.is_empty(), c.startup),
            (None, true, None)
        );
    }

    #[test]
    fn forward_agent_parsed_from_payload() {
        let (db, crypto, vault) = fixture();
        for (i, (v, want)) in [
            (serde_json::json!(true), true),
            (serde_json::json!("yes"), false),
            (serde_json::Value::Null, false),
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("h{i}");
            host_with(
                &db,
                &crypto,
                &id,
                &vault,
                serde_json::json!({"address": "a", "forwardAgent": v}),
            );
            assert_eq!(
                crate::ssh::load_host_config(&db, &crypto, &id)
                    .unwrap()
                    .forward_agent,
                want
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn host_in(
        db: &db::LocalDb,
        crypto: &CryptoState,
        id: &str,
        vault: &str,
        auth: &str,
        key_id: Option<&str>,
        group: Option<&str>,
        payload: serde_json::Value,
    ) {
        let data = crypto::encrypt_secret(
            &payload.to_string(),
            "hosts",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO hosts (id, vault_id, name, data, auth_type, key_id, group_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')",
            rusqlite::params![id, vault, data, auth, key_id, group],
        ).unwrap();
    }

    pub(crate) fn group_with(
        db: &db::LocalDb,
        crypto: &CryptoState,
        id: &str,
        vault: &str,
        parent: Option<&str>,
        payload: serde_json::Value,
        deleted: bool,
    ) {
        let data = crypto::encrypt_secret(
            &payload.to_string(),
            "groups",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO groups (id, vault_id, name, parent_id, data, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?1, ?3, ?4, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', ?5)",
            rusqlite::params![id, vault, parent, data, deleted.then_some("2026-10-03T00:00:00Z")],
        ).unwrap();
    }

    const PEM: &str =
        "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-body\n-----END OPENSSH PRIVATE KEY-----";

    pub(crate) fn key_row(db: &db::LocalDb, crypto: &CryptoState, id: &str, vault: &str) {
        let data = crypto::encrypt_secret(
            &serde_json::json!({"privateKey": PEM}).to_string(),
            "keys",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO keys (id, vault_id, name, data, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')",
            rusqlite::params![id, vault, data],
        ).unwrap();
    }

    #[test]
    fn chain_stops_on_loop_and_depth() {
        let (db, crypto, vault) = fixture();
        group_with(
            &db,
            &crypto,
            "A",
            &vault,
            Some("B"),
            serde_json::json!({"username": "a"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "B",
            &vault,
            Some("A"),
            serde_json::json!({}),
            false,
        );
        assert_eq!(
            crate::host_inherit::group_chain(&db, &crypto, &vault, Some("A")).len(),
            2
        );
        for i in 0..20 {
            let parent = (i < 19).then(|| format!("g{}", i + 1));
            group_with(
                &db,
                &crypto,
                &format!("g{i}"),
                &vault,
                parent.as_deref(),
                serde_json::json!({}),
                false,
            );
        }
        assert_eq!(
            crate::host_inherit::group_chain(&db, &crypto, &vault, Some("g0")).len(),
            16
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("A"),
            serde_json::json!({"address": "a"}),
        );
        host_in(
            &db,
            &crypto,
            "h2",
            &vault,
            "inherit",
            None,
            Some("g0"),
            serde_json::json!({"address": "a"}),
        );
        assert_eq!(
            resolve_saved_route(&db, &crypto, "h")
                .unwrap()
                .target
                .username,
            "a"
        );
        assert!(resolve_saved_route(&db, &crypto, "h2").is_ok());
    }

    #[test]
    fn chain_stops_at_deleted_or_other_vault_group() {
        let (db, crypto, vault) = fixture();
        group_with(
            &db,
            &crypto,
            "root",
            &vault,
            None,
            serde_json::json!({"keepaliveSecs": 60}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "gone",
            &vault,
            Some("root"),
            serde_json::json!({"username": "x"}),
            true,
        );
        group_with(
            &db,
            &crypto,
            "child",
            &vault,
            Some("gone"),
            serde_json::json!({"username": "c"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "foreign",
            "other-vault",
            None,
            serde_json::json!({"username": "f"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "mixed",
            &vault,
            Some("foreign"),
            serde_json::json!({}),
            false,
        );
        let names = |g| {
            crate::host_inherit::group_chain(&db, &crypto, &vault, Some(g))
                .into_iter()
                .map(|l| l.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("child"), vec!["child"]);
        assert_eq!(names("mixed"), vec!["mixed"]);
        assert!(names("foreign").is_empty());
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("child"),
            serde_json::json!({"address": "a"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!((c.username.as_str(), c.keepalive_secs), ("c", None));
    }

    #[test]
    fn group_key_from_other_vault_is_ignored() {
        let (db, crypto, vault) = fixture();
        key_row(&db, &crypto, "k-other", "other-vault");
        key_row(&db, &crypto, "k-mine", &vault);
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"authType": "key", "keyId": "k-other"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "ok",
            &vault,
            None,
            serde_json::json!({"authType": "key", "keyId": "k-mine"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("g"),
            serde_json::json!({"address": "a"}),
        );
        host_in(
            &db,
            &crypto,
            "h2",
            &vault,
            "inherit",
            None,
            Some("ok"),
            serde_json::json!({"address": "a"}),
        );
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "h")
                .unwrap()
                .private_key,
            None
        );
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "h2")
                .unwrap()
                .private_key
                .as_deref(),
            Some(PEM)
        );
        // The host's own missing key still errors.
        host_in(
            &db,
            &crypto,
            "own",
            &vault,
            "key",
            Some("nope"),
            Some("ok"),
            serde_json::json!({"address": "a"}),
        );
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "own")
                .err()
                .as_deref(),
            Some("key not found")
        );
    }

    #[test]
    fn inherited_password_reaches_config() {
        let (db, crypto, vault) = fixture();
        snippet(&db, &crypto, "s1", &vault, "htop", false);
        group_with(
            &db,
            &crypto,
            "root",
            &vault,
            None,
            serde_json::json!({"authType": "password", "password": "grp-pass",
            "forwardAgent": true, "startup": {"snippetId": "s1"}, "env": [{"name": "A", "value": "1"}]}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "team",
            &vault,
            Some("root"),
            serde_json::json!({"username": "deploy", "keepaliveSecs": 45}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("team"),
            serde_json::json!({"address": "a", "password": "own"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (c.username.as_str(), c.password.as_deref(), c.keepalive_secs),
            ("deploy", Some("grp-pass"), Some(45))
        );
        assert!(c.forward_agent);
        assert_eq!(c.env, vec![("A".to_string(), "1".to_string())]);
        assert_eq!(c.startup, Some(StartupAction::Command("htop".into())));
        host_in(
            &db,
            &crypto,
            "off",
            &vault,
            "password",
            None,
            Some("team"),
            serde_json::json!({"address": "a", "forwardAgent": false, "startup": {"none": true}}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "off").unwrap();
        assert_eq!(
            (c.password, c.forward_agent, c.startup),
            (None, false, None)
        );
    }

    #[test]
    fn defaults_never_include_secrets() {
        let (db, crypto, vault) = fixture();
        key_row(&db, &crypto, "deploy-key", &vault);
        group_with(
            &db,
            &crypto,
            "root",
            &vault,
            None,
            serde_json::json!({"authType": "both", "password": "grp-pass", "keyId": "deploy-key",
            "startup": {"command": "uptime"}, "env": [{"name": "A", "value": "1"}]}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "team",
            &vault,
            Some("root"),
            serde_json::json!({"username": "deploy"}),
            false,
        );
        let out = crate::host_inherit::defaults(&db, &crypto, Some("team"), &vault);
        let text = out.to_string();
        assert!(
            !text.contains("grp-pass") && !text.contains("secret-key-body"),
            "{text}"
        );
        assert_eq!(out["hasPassword"], true);
        assert_eq!(out["keyName"], "deploy-key");
        assert_eq!(
            (out["username"].as_str(), out["usernameFrom"].as_str()),
            (Some("deploy"), Some("team"))
        );
        assert_eq!(
            (out["authType"].as_str(), out["authFrom"].as_str()),
            (Some("both"), Some("root"))
        );
        assert_eq!(
            (out["startupKind"].as_str(), out["startupFrom"].as_str()),
            (Some("command"), Some("root"))
        );
        assert_eq!(
            out["env"],
            serde_json::json!([{"name": "A", "value": "1", "from": "root"}])
        );
        assert!(out.get("forwardAgent").is_none() && out.get("keepaliveSecs").is_none());
        let empty = crate::host_inherit::defaults(&db, &crypto, None, &vault);
        assert_eq!(
            empty,
            serde_json::json!({"hasPassword": false, "startupKind": null, "env": []})
        );
    }

    #[test]
    fn defaults_include_port() {
        let (db, crypto, vault) = fixture();
        group_with(
            &db,
            &crypto,
            "root",
            &vault,
            None,
            serde_json::json!({"port": 2222}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "team",
            &vault,
            Some("root"),
            serde_json::json!({}),
            false,
        );
        let out = crate::host_inherit::defaults(&db, &crypto, Some("team"), &vault);
        assert_eq!(
            (out["port"].as_u64(), out["portFrom"].as_str()),
            (Some(2222), Some("root"))
        );
        assert!(crate::host_inherit::defaults(&db, &crypto, None, &vault)
            .get("port")
            .is_none());
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "none",
            None,
            Some("team"),
            serde_json::json!({"address": "a", "port": null}),
        );
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "h")
                .unwrap()
                .port,
            2222
        );
    }

    #[test]
    fn username_override_used_when_unresolved() {
        let (db, crypto, vault) = fixture();
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"username": ""}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "none",
            None,
            Some("g"),
            serde_json::json!({"address": "a", "username": ""}),
        );
        let route = resolve_saved_route_as(&db, &crypto, "h", Some("typed")).unwrap();
        assert_eq!(route.target.username, "typed");
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "h")
                .err()
                .as_deref(),
            Some("No username set for this host")
        );
        assert_eq!(
            crate::ssh::load_host_config_as(&db, &crypto, "h", Some("  "))
                .err()
                .as_deref(),
            Some("No username set for this host")
        );
    }

    #[test]
    fn missing_username_errors_unless_legacy_host() {
        let (db, crypto, vault) = fixture();
        host_in(
            &db,
            &crypto,
            "new",
            &vault,
            "none",
            None,
            None,
            serde_json::json!({"address": "a", "username": ""}),
        );
        host_in(
            &db,
            &crypto,
            "old",
            &vault,
            "none",
            None,
            None,
            serde_json::json!({"address": "a"}),
        );
        // sftp_connect_saved and connect_saved both go through resolve_saved_route_as.
        assert_eq!(
            resolve_saved_route(&db, &crypto, "new").err().as_deref(),
            Some("No username set for this host")
        );
        assert_eq!(
            resolve_saved_route_as(&db, &crypto, "new", Some("typed"))
                .unwrap()
                .target
                .username,
            "typed"
        );
        assert_eq!(
            resolve_saved_route(&db, &crypto, "old")
                .unwrap()
                .target
                .username,
            "root"
        );
    }

    #[test]
    fn bastion_without_username_is_named_in_the_error() {
        let (db, crypto, vault) = fixture();
        host_in(
            &db,
            &crypto,
            "jump",
            &vault,
            "none",
            None,
            None,
            serde_json::json!({"address": "j", "username": ""}),
        );
        host_in(
            &db,
            &crypto,
            "t",
            &vault,
            "none",
            None,
            None,
            serde_json::json!({"address": "a", "username": "me", "jumpHostId": "jump"}),
        );
        let err = resolve_saved_route(&db, &crypto, "t").err().unwrap();
        assert!(
            err.starts_with("Jump host: No username set for this host"),
            "{err}"
        );
    }

    #[test]
    fn username_override_ignored_when_resolved() {
        let (db, crypto, vault) = fixture();
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"username": "grp"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "own",
            &vault,
            "none",
            None,
            Some("g"),
            serde_json::json!({"address": "a", "username": "me"}),
        );
        host_in(
            &db,
            &crypto,
            "inh",
            &vault,
            "none",
            None,
            Some("g"),
            serde_json::json!({"address": "a"}),
        );
        assert_eq!(
            crate::ssh::load_host_config_as(&db, &crypto, "own", Some("typed"))
                .unwrap()
                .username,
            "me"
        );
        assert_eq!(
            crate::ssh::load_host_config_as(&db, &crypto, "inh", Some("typed"))
                .unwrap()
                .username,
            "grp"
        );
    }

    fn identity_with(
        db: &db::LocalDb,
        crypto: &CryptoState,
        id: &str,
        vault: &str,
        payload: serde_json::Value,
        deleted: bool,
    ) {
        let data = crypto::encrypt_secret(
            &payload.to_string(),
            "identities",
            &crypto.session.lock().unwrap(),
        )
        .unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO identities (id, vault_id, name, data, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?1, ?3, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', ?4)",
            rusqlite::params![id, vault, data, deleted.then_some("2026-10-03T00:00:00Z")],
        ).unwrap();
    }

    fn deploy() -> serde_json::Value {
        serde_json::json!({"username": "deploy", "password": "pw", "keyId": "k1", "totpSecret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"})
    }

    #[test]
    fn host_on_identity_uses_its_login() {
        let (db, crypto, vault) = fixture();
        key_row(&db, &crypto, "k1", &vault);
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "identity",
            None,
            None,
            serde_json::json!({"address": "a", "username": "own", "password": "own", "identityId": "i1"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (
                c.username.as_str(),
                c.password.as_deref(),
                c.private_key.as_deref()
            ),
            ("deploy", Some("pw"), Some(PEM))
        );
        assert_eq!(
            c.totp.map(|t| crate::totp::code(&t, 59)).as_deref(),
            Some("287082")
        );
    }

    #[test]
    fn identity_username_wins_over_host_and_group() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"username": "grp", "authType": "identity", "identityId": "i1"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("g"),
            serde_json::json!({"address": "a", "username": "own"}),
        );
        assert_eq!(
            crate::ssh::load_host_config_as(&db, &crypto, "h", Some("typed"))
                .unwrap()
                .username,
            "deploy"
        );
    }

    #[test]
    fn group_identity_inherited_as_unit() {
        let (db, crypto, vault) = fixture();
        key_row(&db, &crypto, "k1", &vault);
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        group_with(
            &db,
            &crypto,
            "child",
            &vault,
            Some("parent"),
            serde_json::json!({"authType": "identity", "identityId": "i1"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "parent",
            &vault,
            None,
            serde_json::json!({"authType": "password", "password": "parent-pw"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "inherit",
            None,
            Some("child"),
            serde_json::json!({"address": "a", "password": "own"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (
                c.username.as_str(),
                c.password.as_deref(),
                c.private_key.as_deref()
            ),
            ("deploy", Some("pw"), Some(PEM))
        );
        assert!(c.totp.is_some());
    }

    #[test]
    fn identity_from_other_vault_is_ignored() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "foreign", "other-vault", deploy(), false);
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "identity",
            None,
            None,
            serde_json::json!({"address": "a", "username": "own", "identityId": "foreign"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (c.username.as_str(), c.password.as_deref(), c.totp.is_some()),
            ("own", None, false)
        );
        group_with(
            &db,
            &crypto,
            "child",
            &vault,
            Some("parent"),
            serde_json::json!({"authType": "identity", "identityId": "foreign"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "parent",
            &vault,
            None,
            serde_json::json!({"authType": "password", "password": "parent-pw"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h2",
            &vault,
            "inherit",
            None,
            Some("child"),
            serde_json::json!({"address": "a", "username": "own"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h2").unwrap();
        assert_eq!(
            (c.username.as_str(), c.password.as_deref(), c.totp.is_some()),
            ("own", Some("parent-pw"), false)
        );
    }

    #[test]
    fn deleted_identity_falls_back() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "gone", &vault, deploy(), true);
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "identity",
            None,
            None,
            serde_json::json!({"address": "a", "username": "own", "password": "own", "identityId": "gone"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (
                c.username.as_str(),
                c.password.as_deref(),
                c.private_key,
                c.totp.is_some()
            ),
            ("own", None, None, false)
        );
        group_with(
            &db,
            &crypto,
            "child",
            &vault,
            Some("parent"),
            serde_json::json!({"authType": "identity", "identityId": "gone"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "parent",
            &vault,
            None,
            serde_json::json!({"authType": "password", "password": "parent-pw"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h2",
            &vault,
            "inherit",
            None,
            Some("child"),
            serde_json::json!({"address": "a", "username": "own"}),
        );
        assert_eq!(
            crate::ssh::load_host_config(&db, &crypto, "h2")
                .unwrap()
                .password
                .as_deref(),
            Some("parent-pw")
        );
    }

    #[test]
    fn identity_key_unusable_drops_key_only() {
        let (db, crypto, vault) = fixture();
        key_row(&db, &crypto, "k-other", "other-vault");
        identity_with(
            &db,
            &crypto,
            "i1",
            &vault,
            serde_json::json!({"username": "deploy", "password": "pw", "keyId": "k-other", "totpSecret": "not base32!"}),
            false,
        );
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "identity",
            None,
            None,
            serde_json::json!({"address": "a", "identityId": "i1"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (
                c.username.as_str(),
                c.password.as_deref(),
                c.private_key,
                c.totp.is_some()
            ),
            ("deploy", Some("pw"), None, false)
        );
    }

    #[test]
    fn non_identity_hosts_unchanged() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        host_in(
            &db,
            &crypto,
            "h",
            &vault,
            "password",
            None,
            None,
            serde_json::json!({"address": "a", "username": "own", "password": "own", "identityId": "i1"}),
        );
        let c = crate::ssh::load_host_config(&db, &crypto, "h").unwrap();
        assert_eq!(
            (c.username.as_str(), c.password.as_deref(), c.totp.is_some()),
            ("own", Some("own"), false)
        );
    }

    #[test]
    fn identity_usage_counts_hosts_and_groups() {
        let (db, crypto, vault) = fixture();
        let on = |id: &str| serde_json::json!({"address": "a", "identityId": id});
        host_in(&db, &crypto, "h1", &vault, "identity", None, None, on("i1"));
        host_in(&db, &crypto, "h2", &vault, "identity", None, None, on("i2"));
        host_in(&db, &crypto, "h3", &vault, "inherit", None, None, on("i1"));
        host_in(&db, &crypto, "h4", &vault, "identity", None, None, on("i1"));
        host_in(
            &db,
            &crypto,
            "h5",
            "other-vault",
            "identity",
            None,
            None,
            on("i1"),
        );
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE hosts SET deleted_at = '2026-10-03T00:00:00Z' WHERE id = 'h4'",
                [],
            )
            .unwrap();
        group_with(
            &db,
            &crypto,
            "g1",
            &vault,
            None,
            serde_json::json!({"authType": "identity", "identityId": "i1"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "g2",
            &vault,
            None,
            serde_json::json!({"authType": "password", "identityId": "i1"}),
            false,
        );
        group_with(
            &db,
            &crypto,
            "g3",
            &vault,
            None,
            serde_json::json!({"authType": "identity", "identityId": "i1"}),
            true,
        );
        assert_eq!(
            crate::host_inherit::usage(&db, &crypto, "i1", &vault),
            (1, 1)
        );
    }

    #[test]
    fn defaults_include_identity_name_not_secrets() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"authType": "identity", "identityId": "i1"}),
            false,
        );
        let out = crate::host_inherit::defaults(&db, &crypto, Some("g"), &vault);
        assert_eq!(out["identityName"], "i1");
        assert_eq!(out["identityFrom"], "g");
        assert_eq!(out["identityUsername"], "deploy");
        assert_eq!(
            (out["authType"].as_str(), out["authFrom"].as_str()),
            (Some("identity"), Some("g"))
        );
        let text = out.to_string();
        assert!(
            !text.contains("\"pw\"") && !text.contains("GEZDGNBV"),
            "{text}"
        );
    }

    #[test]
    fn defaults_report_the_group_username_apart_from_the_identity() {
        let (db, crypto, vault) = fixture();
        identity_with(&db, &crypto, "i1", &vault, deploy(), false);
        group_with(
            &db,
            &crypto,
            "g",
            &vault,
            None,
            serde_json::json!({"authType": "identity", "identityId": "i1"}),
            false,
        );
        let out = crate::host_inherit::defaults(&db, &crypto, Some("g"), &vault);
        assert_eq!(out["username"], "deploy");
        assert!(out.get("groupUsername").is_none(), "{out}");
        group_with(
            &db,
            &crypto,
            "g2",
            &vault,
            None,
            serde_json::json!({"username": "grp", "authType": "identity", "identityId": "i1"}),
            false,
        );
        let out = crate::host_inherit::defaults(&db, &crypto, Some("g2"), &vault);
        assert_eq!(out["groupUsername"], "grp");
    }
}
