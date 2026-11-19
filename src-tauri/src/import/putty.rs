//! PuTTY saved sessions: the Windows registry, `~/.putty/sessions`, or a regedit `.reg` export.

use super::encoding::percent_decode;
use super::{describe_key, ImportPreview, ImportedHost, Skipped};
use std::collections::HashMap;
use std::path::Path;

#[cfg(windows)]
pub(crate) const REG_PATH: &str = r"Software\SimonTatham\PuTTY\Sessions";

/// One saved session (encoded name, its values as text) into a host or a skip reason.
fn session(encoded: &str, values: &HashMap<String, String>, out: &mut ImportPreview) {
    let name = percent_decode(encoded);
    if name == "Default Settings" {
        return;
    }
    let get = |k: &str| values.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
    let protocol = get("Protocol").unwrap_or("ssh").to_ascii_lowercase();
    if protocol != "ssh" {
        out.skipped.push(Skipped {
            name,
            reason: format!("{protocol} session"),
        });
        return;
    }
    let Some(target) = get("HostName") else {
        out.skipped.push(Skipped {
            name,
            reason: "No host name".into(),
        });
        return;
    };
    let (user_in_host, hostname) = match target.rsplit_once('@') {
        Some((u, h)) => (Some(u.to_string()), h.to_string()),
        None => (None, target.to_string()),
    };
    out.hosts.push(ImportedHost {
        id: name.clone(),
        name,
        hostname,
        port: get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
        user: get("UserName").map(String::from).or(user_in_host),
        key: get("PublicKeyFile").map(|p| describe_key(Path::new(p))),
        jump: None,
        folder: Vec::new(),
        tags: Vec::new(),
    });
}

fn empty(origin: &str) -> ImportPreview {
    ImportPreview {
        source: "putty".into(),
        origin: origin.into(),
        hosts: Vec::new(),
        skipped: Vec::new(),
    }
}

/// A regedit value: `"text"` (with `\\` and `\"` escapes) or `dword:hex`, as plain text.
fn reg_value(raw: &str) -> String {
    if let Some(hex) = raw.strip_prefix("dword:") {
        return u32::from_str_radix(hex.trim(), 16)
            .map(|n| n.to_string())
            .unwrap_or_default();
    }
    let inner = raw
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(raw);
    inner
        .replace("\\\\", "\u{0}")
        .replace("\\\"", "\"")
        .replace('\u{0}', "\\")
}

pub(crate) fn parse_reg(text: &str, origin: &str) -> ImportPreview {
    let mut out = empty(origin);
    let marker = r"\SimonTatham\PuTTY\Sessions\";
    for (section, entries) in super::ini::sections(text) {
        let Some(pos) = section.find(marker) else {
            continue;
        };
        let encoded = &section[pos + marker.len()..];
        if encoded.is_empty() || encoded.contains('\\') {
            continue;
        }
        let values = entries
            .into_iter()
            .map(|(k, v)| (k.trim_matches('"').to_string(), reg_value(&v)))
            .collect();
        session(encoded, &values, &mut out);
    }
    out
}

pub(crate) fn parse_sessions_dir(dir: &Path) -> ImportPreview {
    let mut out = empty(&dir.to_string_lossy());
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // No folder just means PuTTY isn't used here.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            out.skipped.push(Skipped {
                name: dir.to_string_lossy().into_owned(),
                reason: format!("Couldn't list sessions: {e}"),
            });
            return out;
        }
    };
    let mut files = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => files.push(entry.path()),
            Err(e) => out.skipped.push(Skipped {
                name: dir.to_string_lossy().into_owned(),
                reason: format!("Couldn't list a session: {e}"),
            }),
        }
    }
    files.sort();
    for path in files {
        let Some(encoded) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let text = match super::read_source_file(&path) {
            Ok(text) => text,
            Err(reason) => {
                out.skipped.push(Skipped {
                    name: percent_decode(&encoded),
                    reason,
                });
                continue;
            }
        };
        let values = text
            .lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.to_string()))
            .collect();
        session(&encoded, &values, &mut out);
    }
    out
}

#[cfg(windows)]
pub(crate) fn read_registry() -> Option<ImportPreview> {
    use winreg::{enums::HKEY_CURRENT_USER, types::FromRegValue, RegKey};
    let sessions = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(REG_PATH)
        .ok()?;
    let mut out = empty(&format!(r"HKEY_CURRENT_USER\{REG_PATH}"));
    for encoded in sessions.enum_keys().flatten() {
        let Ok(key) = sessions.open_subkey(&encoded) else {
            continue;
        };
        let values = key
            .enum_values()
            .flatten()
            .map(|(name, value)| {
                let text = match value.vtype {
                    winreg::enums::REG_DWORD => u32::from_reg_value(&value)
                        .map(|n| n.to_string())
                        .unwrap_or_default(),
                    _ => String::from_reg_value(&value).unwrap_or_default(),
                };
                (name, text)
            })
            .collect();
        session(&encoded, &values, &mut out);
    }
    (!out.hosts.is_empty() || !out.skipped.is_empty()).then_some(out)
}

/// The detected PuTTY sessions on this device, if any.
pub(crate) fn detected(home: &Path) -> Option<ImportPreview> {
    #[cfg(windows)]
    if let Some(found) = read_registry() {
        return Some(found);
    }
    let dir = home.join(".putty").join("sessions");
    let found = parse_sessions_dir(&dir);
    (!found.hosts.is_empty() || !found.skipped.is_empty()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REG: &str = r#"Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Default%20Settings]
"HostName"=""

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\My%20Server]
"HostName"="10.0.0.4"
"UserName"="deploy"
"PortNumber"=dword:00000016
"Protocol"="ssh"
"PublicKeyFile"="C:\\keys\\a.ppk"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\db]
"HostName"="root@db.example.com"
"PortNumber"=dword:0000115c
"Protocol"="ssh"
"PublicKeyFile"=""

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\router]
"HostName"="192.168.1.1"
"Protocol"="telnet"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\console]
"HostName"=""
"Protocol"="serial"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\caf%C3%A9]
"HostName"="cafe.local"
"Protocol"="ssh"
"#;

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts
            .iter()
            .find(|h| h.name == name)
            .unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn reg_maps_ssh_sessions() {
        let p = parse_reg(REG, "file.reg");
        assert_eq!(p.source, "putty");
        let web = host(&p, "My Server");
        assert_eq!((web.hostname.as_str(), web.port), ("10.0.0.4", 22));
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.key.as_ref().unwrap().path, r"C:\keys\a.ppk");
        assert_eq!(web.key.as_ref().unwrap().status, "missing");
        assert!(web.folder.is_empty());
        let db = host(&p, "db");
        assert_eq!(db.port, 4444);
        assert!(db.key.is_none());
    }

    #[test]
    fn reg_user_in_hostname() {
        let db = parse_reg(REG, "f")
            .hosts
            .into_iter()
            .find(|h| h.name == "db")
            .unwrap();
        assert_eq!(
            (db.hostname.as_str(), db.user.as_deref()),
            ("db.example.com", Some("root"))
        );
    }

    #[test]
    fn reg_skips_default_and_non_ssh() {
        let p = parse_reg(REG, "f");
        assert!(p.hosts.iter().all(|h| h.name != "Default Settings"));
        assert!(p.skipped.iter().all(|s| s.name != "Default Settings"));
        let reason = |n: &str| {
            p.skipped
                .iter()
                .find(|s| s.name == n)
                .map(|s| s.reason.clone())
        };
        assert_eq!(reason("router").as_deref(), Some("telnet session"));
        assert_eq!(reason("console").as_deref(), Some("serial session"));
    }

    #[test]
    fn non_ascii_name_decoded() {
        assert_eq!(host(&parse_reg(REG, "f"), "café").hostname, "cafe.local");
    }

    #[test]
    fn reg_utf16_bom_crlf() {
        let dir = std::env::temp_dir().join(format!("shetu-putty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("putty.reg");
        let mut bytes = vec![0xFF, 0xFE];
        for u in REG.replace('\n', "\r\n").encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&path, bytes).unwrap();
        let text = crate::import::read_source_file(&path).unwrap();
        assert_eq!(parse_reg(&text, "f"), parse_reg(REG, "f"));
    }

    #[test]
    fn unreadable_session_file_is_listed() {
        let dir = std::env::temp_dir().join(format!("shetu-putty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        let p = parse_sessions_dir(&dir);
        // Unix opens the directory and finds it isn't a file; Windows can't open it at all.
        assert!(
            p.skipped.iter().any(|s| s.name == "broken"
                && (s.reason.contains("isn't a file") || s.reason.contains("Couldn't open"))),
            "{p:?}"
        );
    }

    #[test]
    fn unlistable_sessions_folder_is_reported() {
        let file = std::env::temp_dir().join(format!("shetu-putty-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, "not a folder").unwrap();
        let p = parse_sessions_dir(&file);
        assert_eq!(p.skipped.len(), 1, "{p:?}");
        // A missing folder just means PuTTY isn't here.
        assert!(parse_sessions_dir(&file.with_extension("missing"))
            .skipped
            .is_empty());
    }

    #[test]
    fn sessions_dir_maps_files() {
        let dir = std::env::temp_dir().join(format!("shetu-putty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("web%20one"),
            "HostName=w.example.com\nUserName=me\nPortNumber=2222\nProtocol=ssh\n",
        )
        .unwrap();
        std::fs::write(dir.join("Default%20Settings"), "HostName=\n").unwrap();
        let p = parse_sessions_dir(&dir);
        assert_eq!(p.hosts.len(), 1);
        let h = &p.hosts[0];
        assert_eq!(
            (h.name.as_str(), h.hostname.as_str(), h.port),
            ("web one", "w.example.com", 2222)
        );
        assert_eq!(h.user.as_deref(), Some("me"));
    }
}
