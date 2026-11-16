//! Host export as an ssh_config snippet or CSV. Never includes passwords, keys or TOTP secrets.

use crate::db::{self, LocalDb, Table};
use crate::host_inherit;
use crate::CryptoState;
use std::collections::HashMap;

struct Exported {
    name: String,
    address: String,
    port: u16,
    user: Option<String>,
    group: Vec<String>,
    tags: Vec<String>,
    jump: Option<String>,
    key: Option<String>,
}

/// Group names from the root down to `id`, following `parent_id` (cycle- and depth-safe).
fn group_path(groups: &HashMap<String, (String, Option<String>)>, id: Option<&str>) -> Vec<String> {
    let mut path = Vec::new();
    let mut next = id.map(String::from);
    while let Some(id) = next.take() {
        if path.len() >= 32 {
            break;
        }
        let Some((name, parent)) = groups.get(&id) else { break };
        path.push(name.clone());
        next = parent.clone();
    }
    path.reverse();
    path
}

fn hosts(db: &LocalDb, crypto: &CryptoState, vault_id: &str, group_id: Option<&str>) -> Result<Vec<Exported>, String> {
    let groups: HashMap<String, (String, Option<String>)> = db::list_sync_rows(db, Table::Groups, vault_id, false)?
        .into_iter()
        .map(|g| (g.id, (g.name.unwrap_or_default(), g.parent_id)))
        .collect();
    let rows = db::list_sync_rows(db, Table::Hosts, vault_id, false)?;
    let names: HashMap<&str, &str> = rows.iter().map(|r| (r.id.as_str(), r.name.as_deref().unwrap_or(""))).collect();
    if group_id.is_some_and(|id| !groups.contains_key(id)) {
        return Err("That group no longer exists".into());
    }
    // In the subtree when `group_id` is on the host's parent chain (by id: names can repeat).
    let in_subtree = |mut at: Option<String>| {
        let Some(root) = group_id else { return true };
        for _ in 0..32 {
            match at {
                Some(id) if id == root => return true,
                Some(id) => at = groups.get(&id).and_then(|(_, parent)| parent.clone()),
                None => return false,
            }
        }
        false
    };
    let mut out = Vec::new();
    for row in &rows {
        if !in_subtree(row.group_id.clone()) {
            continue;
        }
        let group = group_path(&groups, row.group_id.as_deref());
        let payload: serde_json::Value = {
            let session = crypto.session.lock().map_err(|e| e.to_string())?;
            let Ok(plain) = crate::team_keys::decrypt_row_secret(db, &session, &row.data, "hosts", &row.vault_id) else { continue };
            serde_json::from_str(&plain).unwrap_or_default()
        };
        let chain = host_inherit::group_chain(db, crypto, &row.vault_id, row.group_id.as_deref());
        let effective = host_inherit::resolve_with(
            &payload,
            row.auth_type.as_deref().unwrap_or("password"),
            row.key_id.as_deref(),
            &chain,
            &|id| host_inherit::usable_identity(db, crypto, id, &row.vault_id),
        );
        out.push(Exported {
            name: row.name.clone().unwrap_or_default(),
            address: payload["address"].as_str().unwrap_or_default().to_string(),
            port: effective.port.0,
            user: effective.username.map(|(u, _)| u),
            group,
            tags: row.tags.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default(),
            jump: payload["jumpHostId"].as_str().and_then(|id| names.get(id)).map(|n| n.to_string()),
            key: effective
                .key_id
                .and_then(|id| host_inherit::usable_key(db, &id, &row.vault_id))
                .and_then(|k| k.name),
        });
    }
    out.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));
    Ok(out)
}

/// A config word, quoted when it has spaces or quotes so `ssh` reads it as one argument.
fn word(s: &str) -> String {
    if s.is_empty() || s.contains(|c: char| c.is_whitespace() || c == '"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn ssh_config(hosts: &[Exported]) -> String {
    let mut out = String::from("# Exported from Shetu. Keys stay in your Shetu vault.\n");
    for h in hosts {
        out.push_str(&format!("\nHost {}\n  HostName {}\n", word(&h.name), word(&h.address)));
        if let Some(user) = &h.user {
            out.push_str(&format!("  User {}\n", word(user)));
        }
        out.push_str(&format!("  Port {}\n", h.port));
        if let Some(jump) = &h.jump {
            out.push_str(&format!("  ProxyJump {}\n", word(jump)));
        }
        if let Some(key) = &h.key {
            out.push_str(&format!("  # key: {key}\n"));
        }
    }
    out
}

fn csv(hosts: &[Exported]) -> Result<String, String> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(["label", "address", "port", "username", "group", "tags"]).map_err(|e| e.to_string())?;
    for h in hosts {
        w.write_record([
            h.name.as_str(),
            h.address.as_str(),
            &h.port.to_string(),
            h.user.as_deref().unwrap_or(""),
            &h.group.join("/"),
            &h.tags.join(";"),
        ])
        .map_err(|e| e.to_string())?;
    }
    String::from_utf8(w.into_inner().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub(crate) fn export(db: &LocalDb, crypto: &CryptoState, vault_id: &str, group_id: Option<&str>, format: &str) -> Result<String, String> {
    let hosts = hosts(db, crypto, vault_id, group_id)?;
    match format {
        "ssh_config" => Ok(ssh_config(&hosts)),
        "csv" => csv(&hosts),
        _ => Err("Unknown export format".into()),
    }
}

#[tauri::command]
pub async fn export_hosts(
    vault_id: String,
    group_id: Option<String>,
    format: String,
    db: tauri::State<'_, LocalDb>,
    crypto: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    export(&db, &crypto, &vault_id, group_id.as_deref(), &format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_route::tests::{fixture, group_with, host_in, key_row};
    use serde_json::json;

    fn vault() -> (LocalDb, CryptoState, String) {
        let (db, crypto, vault) = fixture();
        group_with(&db, &crypto, "Prod", &vault, None, json!({"username": "deploy"}), false);
        group_with(&db, &crypto, "Web", &vault, Some("Prod"), json!({}), false);
        group_with(&db, &crypto, "Other", &vault, None, json!({}), false);
        key_row(&db, &crypto, "k1", &vault);
        host_in(&db, &crypto, "bastion", &vault, "password", None, Some("Prod"), json!({"address": "b.example.com", "port": 22, "password": "pw"}));
        host_in(&db, &crypto, "my web", &vault, "key", Some("k1"), Some("Web"), json!({"address": "10.0.0.4", "port": 2222, "jumpHostId": "bastion"}));
        host_in(&db, &crypto, "lone", &vault, "password", None, Some("Other"), json!({"address": "l.example.com", "username": "me"}));
        db.conn.lock().unwrap().execute("UPDATE hosts SET tags = '[\"a\",\"b\"]' WHERE id = 'my web'", []).unwrap();
        (db, crypto, vault)
    }

    #[test]
    fn export_ssh_config_effective_values() {
        let (db, crypto, vault) = vault();
        let out = export(&db, &crypto, &vault, None, "ssh_config").unwrap();
        assert!(out.contains("Host \"my web\"\n  HostName 10.0.0.4\n  User deploy\n  Port 2222\n  ProxyJump bastion\n  # key: k1\n"), "{out}");
        assert!(out.contains("Host bastion\n  HostName b.example.com\n  User deploy\n  Port 22\n"), "{out}");
        assert!(!out.contains("pw") && !out.contains("PRIVATE KEY") && !out.contains("password"), "{out}");
    }

    #[test]
    fn export_csv_round_trips() {
        let (db, crypto, vault) = vault();
        let out = export(&db, &crypto, &vault, None, "csv").unwrap();
        assert!(out.starts_with("label,address,port,username,group,tags\n"), "{out}");
        let back = crate::import::termius_csv::parse_csv(&out, "export.csv").unwrap();
        let web = back.hosts.iter().find(|h| h.name == "my web").unwrap();
        assert_eq!((web.hostname.as_str(), web.port, web.user.as_deref()), ("10.0.0.4", 2222, Some("deploy")));
        assert_eq!(web.folder, vec!["Prod".to_string(), "Web".to_string()]);
        assert_eq!(web.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(back.hosts.len(), 3);
    }

    #[test]
    fn export_group_subtree_only() {
        let (db, crypto, vault) = vault();
        let out = export(&db, &crypto, &vault, Some("Prod"), "csv").unwrap();
        assert!(out.contains("my web") && out.contains("bastion") && !out.contains("lone"), "{out}");
    }

    #[test]
    fn export_group_by_id_not_name() {
        let (db, crypto, vault) = fixture();
        group_with(&db, &crypto, "s1", &vault, None, json!({}), false);
        group_with(&db, &crypto, "s2", &vault, None, json!({}), false);
        db.conn.lock().unwrap().execute("UPDATE groups SET name = 'Servers'", []).unwrap();
        host_in(&db, &crypto, "one", &vault, "password", None, Some("s1"), json!({"address": "1.1.1.1"}));
        host_in(&db, &crypto, "two", &vault, "password", None, Some("s2"), json!({"address": "2.2.2.2"}));
        let out = export(&db, &crypto, &vault, Some("s1"), "csv").unwrap();
        assert!(out.contains("1.1.1.1") && !out.contains("2.2.2.2"), "{out}");
        assert!(export(&db, &crypto, &vault, Some("gone"), "csv").is_err());
    }

    #[test]
    fn export_unknown_format_errors() {
        let (db, crypto, vault) = vault();
        assert!(export(&db, &crypto, &vault, None, "xml").is_err());
    }
}
