//! WinSCP sites: the Windows registry or `WinSCP.ini`. Site paths `Folder/Sub/name` become groups.

use super::encoding::percent_decode;
use super::{describe_key, ImportPreview, ImportedHost, Skipped};
use std::collections::HashMap;
use std::path::Path;

#[cfg(windows)]
const REG_PATH: &str = r"Software\Martin Prikryl\WinSCP 2\Sessions";

fn empty(origin: &str) -> ImportPreview {
    ImportPreview { source: "winscp".into(), origin: origin.into(), hosts: Vec::new(), skipped: Vec::new() }
}

/// One site (its encoded `Folder/Sub/name` path and raw values) into a host or a skip reason.
fn site(encoded: &str, values: &HashMap<String, String>, out: &mut ImportPreview) {
    let path = percent_decode(encoded);
    if path == "Default Settings" {
        return;
    }
    let mut parts: Vec<String> = path.split('/').map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect();
    let Some(name) = parts.pop() else { return };
    let get = |k: &str| values.get(k).map(|v| percent_decode(v.trim())).filter(|v| !v.is_empty());
    // Workspaces are saved as `<name>/0000` entries pointing at real sites.
    if get("IsWorkspace").as_deref() == Some("1") {
        return;
    }
    // 0 SCP, 1 SFTP with SCP fallback, 2 SFTP; 5 FTP, 6 WebDAV, 7 S3.
    if !matches!(get("FSProtocol").as_deref(), None | Some("0" | "1" | "2")) {
        out.skipped.push(Skipped { name, reason: "FTP/WebDAV/S3 session".into() });
        return;
    }
    let Some(hostname) = get("HostName") else {
        out.skipped.push(Skipped { name, reason: "No host name".into() });
        return;
    };
    if get("Tunnel").as_deref() == Some("1") {
        out.skipped.push(Skipped { name: name.clone(), reason: "Tunnel host not imported".into() });
    }
    out.hosts.push(ImportedHost {
        id: path.clone(),
        name,
        hostname,
        port: get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22),
        user: get("UserName"),
        key: get("PublicKeyFile").map(|p| describe_key(Path::new(&p))),
        jump: None,
        folder: parts,
        tags: Vec::new(),
    });
}

pub(crate) fn parse_ini(text: &str, origin: &str) -> ImportPreview {
    let mut out = empty(origin);
    for (section, entries) in super::ini::sections(text) {
        let Some(encoded) = section.strip_prefix("Sessions\\") else { continue };
        site(encoded, &entries.into_iter().collect(), &mut out);
    }
    out
}

#[cfg(windows)]
fn read_registry() -> Option<ImportPreview> {
    use winreg::{enums::HKEY_CURRENT_USER, types::FromRegValue, RegKey};
    let sessions = RegKey::predef(HKEY_CURRENT_USER).open_subkey(REG_PATH).ok()?;
    let mut out = empty(&format!(r"HKEY_CURRENT_USER\{REG_PATH}"));
    for encoded in sessions.enum_keys().flatten() {
        let Ok(key) = sessions.open_subkey(&encoded) else { continue };
        let values = key
            .enum_values()
            .flatten()
            .map(|(name, value)| {
                let text = match value.vtype {
                    winreg::enums::REG_DWORD => u32::from_reg_value(&value).map(|n| n.to_string()).unwrap_or_default(),
                    _ => String::from_reg_value(&value).unwrap_or_default(),
                };
                (name, text)
            })
            .collect();
        site(&encoded, &values, &mut out);
    }
    (!out.hosts.is_empty() || !out.skipped.is_empty()).then_some(out)
}

/// The detected WinSCP sites on this device (Windows only), if any.
pub(crate) fn detected() -> Option<ImportPreview> {
    #[cfg(windows)]
    {
        if let Some(found) = read_registry() {
            return Some(found);
        }
        let ini = dirs::config_dir()?.join("WinSCP.ini");
        let text = super::read_source_file(&ini).ok()?;
        let found = parse_ini(&text, &ini.to_string_lossy());
        return (!found.hosts.is_empty() || !found.skipped.is_empty()).then_some(found);
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const INI: &str = "[Configuration\\Interface]\r\nTheme=dark\r\n\r\n\
[Sessions\\Default%20Settings]\r\nHostName=\r\n\
[Sessions\\Prod/Web/web%2D1]\r\nHostName=10.0.0.4\r\nUserName=deploy\r\nPortNumber=2222\r\nFSProtocol=2\r\nPublicKeyFile=C:%5Ckeys%5Ca.ppk\r\n\
[Sessions\\ftp-site]\r\nHostName=ftp.example.com\r\nFSProtocol=5\r\n\
[Sessions\\inner]\r\nHostName=10.1.0.5\r\nTunnel=1\r\nTunnelHostName=bastion\r\n\
[Sessions\\plain]\r\nHostName=p.example.com\r\n";

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts.iter().find(|h| h.name == name).unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn ini_maps_folders() {
        let p = parse_ini(INI, "WinSCP.ini");
        assert_eq!(p.source, "winscp");
        let web = host(&p, "web-1");
        assert_eq!(web.folder, vec!["Prod".to_string(), "Web".to_string()]);
        assert_eq!((web.hostname.as_str(), web.port), ("10.0.0.4", 2222));
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.id, "Prod/Web/web-1");
        let plain = host(&p, "plain");
        assert_eq!((plain.port, plain.user.as_deref()), (22, None));
        assert!(plain.folder.is_empty());
    }

    #[test]
    fn ini_skips_ftp() {
        let p = parse_ini(INI, "f");
        assert!(p.hosts.iter().all(|h| h.name != "ftp-site"));
        assert!(p.skipped.iter().any(|s| s.name == "ftp-site" && s.reason == "FTP/WebDAV/S3 session"));
    }

    #[test]
    fn ini_decodes_key_path() {
        let p = parse_ini(INI, "f");
        assert_eq!(host(&p, "web-1").key.as_ref().unwrap().path, r"C:\keys\a.ppk");
    }

    #[test]
    fn ini_tunnel_noted() {
        let p = parse_ini(INI, "f");
        assert_eq!(host(&p, "inner").hostname, "10.1.0.5");
        assert!(p.skipped.iter().any(|s| s.name == "inner" && s.reason == "Tunnel host not imported"));
    }

    #[test]
    fn ini_skips_workspaces() {
        let text = "[Sessions\\Work/0000]\nHostName=10.0.0.4\nIsWorkspace=1\n[Sessions\\real]\nHostName=r\n";
        let p = parse_ini(text, "f");
        assert_eq!(p.hosts.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), ["real"]);
        assert!(p.skipped.is_empty());
    }

    #[test]
    fn ini_ignores_non_session_sections() {
        let p = parse_ini(INI, "f");
        assert_eq!(p.hosts.len(), 3);
        assert!(p.skipped.iter().all(|s| s.name != "Default Settings" && s.name != "Interface"));
    }
}
