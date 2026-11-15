//! Hosts inherit credentials and connection options from their (nested) groups.

use crate::db::{self, LocalDb, Table};
use crate::CryptoState;
use serde_json::{json, Value};

const MAX_DEPTH: usize = 16;

pub(crate) struct GroupLayer {
    pub id: String,
    pub name: String,
    pub vault_id: String,
    pub payload: Value,
}

/// The host's group and its ancestors, nearest first. Stops (keeping what it has) on a loop,
/// a deleted, missing, unreadable or other-vault group, or after `MAX_DEPTH` levels.
pub(crate) fn group_chain(
    db: &LocalDb,
    crypto: &CryptoState,
    host_vault: &str,
    group_id: Option<&str>,
) -> Vec<GroupLayer> {
    let mut chain: Vec<GroupLayer> = Vec::new();
    let mut next = group_id.map(String::from);
    while let Some(id) = next.take() {
        if chain.len() >= MAX_DEPTH || chain.iter().any(|g| g.id == id) {
            break;
        }
        let Some(row) = db::get_sync_row(db, Table::Groups, &id).ok().flatten() else { break };
        if row.deleted_at.is_some() || row.vault_id != host_vault {
            break;
        }
        let Some(payload) = crypto
            .session
            .lock()
            .ok()
            .and_then(|s| crate::team_keys::decrypt_row_secret(db, &s, &row.data, "groups", &row.vault_id).ok())
            .and_then(|plain| serde_json::from_str::<Value>(&plain).ok())
        else {
            break;
        };
        next = row.parent_id.filter(|p| !p.is_empty());
        chain.push(GroupLayer { id, name: row.name.unwrap_or_default(), vault_id: row.vault_id, payload });
    }
    chain
}

/// The resolved values; each `Option<String>` names the group a value came from
/// (`None` = the host's own, or the default).
pub(crate) struct Effective {
    pub username: Option<(String, Option<String>)>,
    pub port: (u16, Option<String>),
    pub auth_type: String,
    pub password: Option<String>,
    pub key_id: Option<String>,
    pub auth_from: Option<String>,
    pub keepalive_secs: Option<(u32, Option<String>)>,
    pub env: Vec<(String, String, Option<String>)>,
    pub startup: (Value, Option<String>),
    pub forward_agent: (bool, Option<String>),
    /// Set when the credentials come from an identity (`auth_type` is then "identity").
    pub identity: Option<IdentityLogin>,
}

/// A saved login many hosts and groups share.
pub(crate) struct IdentityLogin {
    pub name: String,
    pub username: String,
    pub password: Option<String>,
    pub key_id: Option<String>,
    pub totp_secret: Option<String>,
}

fn decrypt_payload(db: &LocalDb, crypto: &CryptoState, row: &db::SyncRow, record_type: &str) -> Option<Value> {
    let session = crypto.session.lock().ok()?;
    let plain = crate::team_keys::decrypt_row_secret(db, &session, &row.data, record_type, &row.vault_id).ok()?;
    serde_json::from_str(&plain).ok()
}

/// The identity a host in `vault` may use: present, not deleted, same vault, with a username.
pub(crate) fn usable_identity(db: &LocalDb, crypto: &CryptoState, id: &str, vault: &str) -> Option<IdentityLogin> {
    let row = db::get_sync_row(db, Table::Identities, id).ok().flatten()?;
    if row.deleted_at.is_some() || row.vault_id != vault {
        return None;
    }
    let payload = decrypt_payload(db, crypto, &row, "identities")?;
    let text = |key: &str| payload[key].as_str().filter(|s| !s.is_empty()).map(String::from);
    Some(IdentityLogin {
        name: row.name.clone().unwrap_or_default(),
        username: text("username")?,
        password: text("password"),
        key_id: text("keyId"),
        totp_secret: text("totpSecret"),
    })
}

/// The host's own value for `key`, else the nearest group's.
fn nearest<T>(
    host: &Value,
    chain: &[GroupLayer],
    key: &str,
    pick: impl Fn(&Value) -> Option<T>,
) -> Option<(T, Option<String>)> {
    pick(&host[key])
        .map(|v| (v, None))
        .or_else(|| chain.iter().find_map(|g| pick(&g.payload[key]).map(|v| (v, Some(g.name.clone())))))
}

fn valid_env_name(name: &str) -> bool {
    let mut ch = name.chars();
    ch.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && ch.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
pub(crate) fn resolve(
    host_payload: &Value,
    host_auth_type: &str,
    host_key_id: Option<&str>,
    chain: &[GroupLayer],
) -> Effective {
    resolve_with(host_payload, host_auth_type, host_key_id, chain, &|_| None)
}

type Credentials = (String, Option<String>, Option<String>, Option<IdentityLogin>);

/// `identity` looks up a usable identity by id; an unusable one leaves its level without credentials.
pub(crate) fn resolve_with(
    host_payload: &Value,
    host_auth_type: &str,
    host_key_id: Option<&str>,
    chain: &[GroupLayer],
    identity: &dyn Fn(&str) -> Option<IdentityLogin>,
) -> Effective {
    let level = |auth: &str, payload: &Value, key_id: Option<&str>| -> Option<Credentials> {
        if auth == "identity" {
            let login = identity(payload["identityId"].as_str()?)?;
            return Some((auth.into(), login.password.clone(), login.key_id.clone(), Some(login)));
        }
        Some((auth.into(), payload["password"].as_str().map(String::from), key_id.map(String::from), None))
    };
    // Credentials resolve as one unit: never mix authType / password / keyId across levels.
    let ((auth_type, password, key_id, identity), auth_from) = if host_auth_type == "inherit" {
        chain
            .iter()
            .find_map(|g| {
                let auth = g.payload["authType"].as_str().filter(|a| ["password", "key", "both", "none", "identity"].contains(a))?;
                Some((level(auth, &g.payload, g.payload["keyId"].as_str())?, Some(g.name.clone())))
            })
            .unwrap_or((("none".into(), None, None, None), None))
    } else {
        let own = level(host_auth_type, host_payload, host_key_id).unwrap_or(("none".into(), None, None, None));
        (own, None)
    };
    let uses_password = ["password", "both", "identity"].contains(&auth_type.as_str());
    let uses_key = ["key", "both", "identity"].contains(&auth_type.as_str());

    let mut env: Vec<(String, String, Option<String>)> = Vec::new();
    let levels = chain.iter().rev().map(|g| (&g.payload, Some(g.name.clone()))).chain([(host_payload, None)]);
    for (payload, from) in levels {
        for row in payload["env"].as_array().into_iter().flatten() {
            let (Some(name), Some(value)) = (row["name"].as_str(), row["value"].as_str()) else { continue };
            if !valid_env_name(name) {
                continue;
            }
            let entry = (name.to_string(), value.to_string(), from.clone());
            match env.iter_mut().find(|e| e.0 == name) {
                Some(existing) => *existing = entry,
                None => env.push(entry),
            }
        }
    }

    Effective {
        // An identity's username wins outright.
        username: match &identity {
            Some(login) => Some((login.username.clone(), auth_from.clone())),
            None => nearest(host_payload, chain, "username", |v| v.as_str().filter(|s| !s.is_empty()).map(String::from)),
        },
        port: nearest(host_payload, chain, "port", |v| v.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0))
            .unwrap_or((22, None)),
        password: password.filter(|_| uses_password),
        key_id: key_id.filter(|_| uses_key),
        auth_type,
        auth_from,
        keepalive_secs: nearest(host_payload, chain, "keepaliveSecs", |v| {
            v.as_f64().map(|n| crate::ssh_options::clamp_keepalive(n as i64))
        }),
        env,
        startup: nearest(host_payload, chain, "startup", |v| (!v.is_null()).then(|| v.clone())).unwrap_or((Value::Null, None)),
        forward_agent: nearest(host_payload, chain, "forwardAgent", Value::as_bool).unwrap_or((false, None)),
        identity,
    }
}

/// A key row usable by a host in `vault`: present, not deleted, same vault.
pub(crate) fn usable_key(db: &LocalDb, key_id: &str, vault: &str) -> Option<db::SyncRow> {
    db::get_sync_row(db, Table::Keys, key_id)
        .ok()
        .flatten()
        .filter(|k| k.deleted_at.is_none() && k.vault_id == vault)
}

/// What a new or "From group" host in `group_id` would inherit. Non-secret values only.
#[tauri::command]
pub fn inherited_host_defaults(
    group_id: Option<String>,
    vault_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<Value, String> {
    Ok(defaults(&db, &crypto, group_id.as_deref(), &vault_id))
}

pub(crate) fn defaults(db: &LocalDb, crypto: &CryptoState, group_id: Option<&str>, vault_id: &str) -> Value {
    let chain = group_chain(db, crypto, vault_id, group_id);
    let e = resolve_with(&json!({}), "inherit", None, &chain, &|id| usable_identity(db, crypto, id, vault_id));
    let mut out = json!({
        "hasPassword": e.password.is_some(),
        "startupKind": Value::Null,
        "env": e.env.iter().map(|(name, value, from)| json!({"name": name, "value": value, "from": from})).collect::<Vec<_>>(),
    });
    if let Some((username, from)) = e.username {
        out["username"] = json!(username);
        out["usernameFrom"] = json!(from);
    }
    if e.auth_from.is_some() {
        out["authType"] = json!(e.auth_type);
        out["authFrom"] = json!(e.auth_from);
    }
    if let Some(login) = &e.identity {
        // Hosts with their own login don't get the identity's username: report the group's plain one.
        if let Some((name, _)) = nearest(&json!({}), &chain, "username", |v| {
            v.as_str().filter(|s| !s.is_empty()).map(String::from)
        }) {
            out["groupUsername"] = json!(name);
        }
        out["identityName"] = json!(login.name);
        out["identityFrom"] = json!(e.auth_from);
        out["identityUsername"] = json!(login.username);
    }
    if let Some(name) = e.key_id.and_then(|id| usable_key(db, &id, vault_id)).and_then(|k| k.name) {
        out["keyName"] = json!(name);
    }
    if let Some((secs, from)) = e.keepalive_secs {
        out["keepaliveSecs"] = json!(secs);
        out["keepaliveFrom"] = json!(from);
    }
    if let (port, Some(from)) = e.port {
        out["port"] = json!(port);
        out["portFrom"] = json!(from);
    }
    let (startup, startup_from) = &e.startup;
    // Same precedence as ssh::load_startup: command, then snippet.
    let kind = if startup["command"].is_string() {
        Some("command")
    } else if startup["snippetId"].is_string() {
        Some("snippet")
    } else if startup["none"] == true {
        Some("none")
    } else {
        None
    };
    if let Some(kind) = kind {
        out["startupKind"] = json!(kind);
        out["startupFrom"] = json!(startup_from);
    }
    if let (on, Some(from)) = e.forward_agent {
        out["forwardAgent"] = json!(on);
        out["forwardAgentFrom"] = json!(from);
    }
    out
}

/// Live hosts and groups in `vault_id` whose own login is the identity (local rows only).
pub(crate) fn usage(db: &LocalDb, crypto: &CryptoState, identity_id: &str, vault_id: &str) -> (u32, u32) {
    let uses = |table: Table, record_type: &str, on_identity: &dyn Fn(&db::SyncRow, &Value) -> bool| {
        db::list_sync_rows(db, table, vault_id, false)
            .unwrap_or_default()
            .iter()
            .filter(|row| {
                decrypt_payload(db, crypto, row, record_type)
                    .is_some_and(|p| p["identityId"] == identity_id && on_identity(row, &p))
            })
            .count() as u32
    };
    (
        uses(Table::Hosts, "hosts", &|row, _| row.auth_type.as_deref() == Some("identity")),
        uses(Table::Groups, "groups", &|_, p| p["authType"] == "identity"),
    )
}

#[derive(serde::Serialize)]
pub struct IdentityUsage {
    hosts: u32,
    groups: u32,
}

/// How many hosts and groups in the vault use the identity, for the delete warning.
#[tauri::command]
pub fn identity_usage(
    identity_id: String,
    vault_id: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> IdentityUsage {
    let (hosts, groups) = usage(&db, &crypto, &identity_id, &vault_id);
    IdentityUsage { hosts, groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(name: &str, payload: Value) -> GroupLayer {
        GroupLayer { id: name.into(), name: name.into(), vault_id: "v".into(), payload }
    }

    #[test]
    fn nearest_group_wins_per_field() {
        let chain = [layer("child", json!({"username": "b"})), layer("parent", json!({"username": "a", "keepaliveSecs": 60}))];
        let e = resolve(&json!({}), "password", None, &chain);
        assert_eq!(e.username, Some(("b".into(), Some("child".into()))));
        assert_eq!(e.keepalive_secs, Some((60, Some("parent".into()))));
    }

    #[test]
    fn port_inherits_from_group() {
        let chain = [layer("child", json!({})), layer("parent", json!({"port": 2222}))];
        assert_eq!(resolve(&json!({"port": null}), "none", None, &chain).port, (2222, Some("parent".into())));
        assert_eq!(resolve(&json!({}), "none", None, &[]).port, (22, None));
    }

    #[test]
    fn legacy_port_unchanged() {
        let chain = [layer("g", json!({"port": 2222}))];
        assert_eq!(resolve(&json!({"port": 2200}), "none", None, &chain).port, (2200, None));
    }

    #[test]
    fn invalid_port_ignored() {
        let chain = [layer("g", json!({"port": 2222}))];
        for bad in [json!(0), json!(70000), json!("22"), json!(-1)] {
            assert_eq!(resolve(&json!({"port": bad}), "none", None, &chain).port, (2222, Some("g".into())), "{bad}");
            assert_eq!(resolve(&json!({"port": bad}), "none", None, &[]).port, (22, None), "{bad}");
        }
        let bad_group = [layer("g", json!({"port": 70000}))];
        assert_eq!(resolve(&json!({}), "none", None, &bad_group).port, (22, None));
    }

    #[test]
    fn credentials_resolve_as_one_unit() {
        let chain = [
            layer("child", json!({"authType": "key", "keyId": "k1"})),
            layer("parent", json!({"authType": "password", "password": "p"})),
        ];
        let e = resolve(&json!({"password": "own"}), "inherit", Some("own-key"), &chain);
        assert_eq!((e.auth_type.as_str(), e.key_id.as_deref(), e.password), ("key", Some("k1"), None));
        assert_eq!(e.auth_from.as_deref(), Some("child"));
    }

    #[test]
    fn inherit_without_group_auth_is_none() {
        let chain = [layer("g", json!({"username": "u", "password": "p", "keyId": "k"}))];
        let e = resolve(&json!({"password": "own"}), "inherit", Some("own-key"), &chain);
        assert_eq!((e.auth_type.as_str(), e.password, e.key_id, e.auth_from), ("none", None, None, None));
        assert_eq!(resolve(&json!({}), "inherit", None, &[]).auth_type, "none");
    }

    #[test]
    fn host_own_auth_ignores_groups() {
        let chain = [layer("g", json!({"authType": "key", "keyId": "k"}))];
        let e = resolve(&json!({"password": "own"}), "password", None, &chain);
        assert_eq!((e.auth_type.as_str(), e.password.as_deref(), e.key_id, e.auth_from), ("password", Some("own"), None, None));
    }

    #[test]
    fn env_merges_root_first_host_last() {
        let chain = [
            layer("child", json!({"env": [{"name": "B", "value": "2"}]})),
            layer("parent", json!({"env": [{"name": "A", "value": "1"}, {"name": "B", "value": "1"}, {"name": "1BAD", "value": "x"}]})),
        ];
        let e = resolve(&json!({"env": [{"name": "C", "value": "3"}, {"name": "A", "value": "9"}]}), "none", None, &chain);
        let got: Vec<_> = e.env.iter().map(|(n, v, f)| (n.as_str(), v.as_str(), f.as_deref())).collect();
        assert_eq!(got, vec![("A", "9", None), ("B", "2", Some("child")), ("C", "3", None)]);
    }

    #[test]
    fn startup_null_inherits_none_marker_blocks() {
        let chain = [layer("g", json!({"startup": {"command": "htop"}}))];
        let e = resolve(&json!({"startup": null}), "none", None, &chain);
        assert_eq!(e.startup, (json!({"command": "htop"}), Some("g".into())));
        let e = resolve(&json!({"startup": {"none": true}}), "none", None, &chain);
        assert_eq!(e.startup, (json!({"none": true}), None));
    }

    #[test]
    fn host_off_beats_group_on() {
        let chain = [layer("g", json!({"forwardAgent": true}))];
        assert_eq!(resolve(&json!({"forwardAgent": false}), "none", None, &chain).forward_agent, (false, None));
        assert_eq!(resolve(&json!({}), "none", None, &chain).forward_agent, (true, Some("g".into())));
    }

    #[test]
    fn legacy_host_unchanged_without_group_values() {
        let host = json!({"username": "u", "password": "p", "keepaliveSecs": 30, "forwardAgent": true,
            "env": [{"name": "X", "value": "1"}], "startup": {"command": "ls"}});
        let chain = [layer("g", json!({}))];
        let e = resolve(&host, "both", Some("k"), &chain);
        assert_eq!(e.username, Some(("u".into(), None)));
        assert_eq!((e.auth_type.as_str(), e.password.as_deref(), e.key_id.as_deref(), e.auth_from), ("both", Some("p"), Some("k"), None));
        assert_eq!(e.keepalive_secs, Some((30, None)));
        assert_eq!(e.forward_agent, (true, None));
        assert_eq!(e.env, vec![("X".into(), "1".into(), None)]);
        assert_eq!(e.startup, (json!({"command": "ls"}), None));
        let bare = resolve(&json!({}), "none", None, &[]);
        assert_eq!((bare.username, bare.keepalive_secs, bare.forward_agent, bare.startup), (None, None, (false, None), (Value::Null, None)));
    }
}
