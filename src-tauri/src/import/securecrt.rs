//! SecureCRT sessions: its per-session `.ini` folder, or an "Export Settings" XML file.

use super::{ImportPreview, ImportedHost, Skipped};
use std::collections::HashMap;
use std::path::Path;

fn empty(origin: &str) -> ImportPreview {
    ImportPreview { source: "securecrt".into(), origin: origin.into(), hosts: Vec::new(), skipped: Vec::new() }
}

/// One session's values (names without the `S:`/`D:` type prefix) into a host or a skip reason.
fn session(name: &str, folder: Vec<String>, values: &HashMap<String, String>, port_radix: u32, out: &mut ImportPreview) {
    let get = |k: &str| values.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
    let protocol = get("Protocol Name").unwrap_or("SSH2");
    if !protocol.eq_ignore_ascii_case("SSH2") && !protocol.eq_ignore_ascii_case("SSH1") {
        out.skipped.push(Skipped { name: name.into(), reason: format!("{protocol} session") });
        return;
    }
    let Some(hostname) = get("Hostname") else {
        out.skipped.push(Skipped { name: name.into(), reason: "No host name".into() });
        return;
    };
    if get("Firewall Name").is_some_and(|f| !f.eq_ignore_ascii_case("None")) {
        out.skipped.push(Skipped { name: name.into(), reason: "Proxy not imported".into() });
    }
    // `C:\k\id_rsa.pub::rawkey`: the private key sits next to the public one SecureCRT names.
    let key = get("Identity Filename V2").or(get("Identity Filename")).map(|v| {
        let path = v.split("::").next().unwrap_or(v);
        path.strip_suffix(".pub").unwrap_or(path).to_string()
    });
    let id = folder.iter().map(String::as_str).chain([name]).collect::<Vec<_>>().join("/");
    out.hosts.push(ImportedHost {
        id,
        name: name.into(),
        hostname: hostname.into(),
        port: get("[SSH2] Port")
            .or(get("Port"))
            .and_then(|p| u32::from_str_radix(p, port_radix).ok())
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p != 0)
            .unwrap_or(22),
        user: get("Username").map(String::from),
        key: key.map(|k| super::describe_key(Path::new(&k))),
        jump: None,
        folder,
        tags: Vec::new(),
    });
}

/// `S:"Key"=value` / `D:"Key"=hex` lines into a map keyed by the bare name.
fn ini_values(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let key = key.trim().split_once(':').map_or(key, |(_, k)| k).trim().trim_matches('"');
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn walk(dir: &Path, folder: Vec<String>, depth: u8, out: &mut ImportPreview) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            out.skipped.push(Skipped { name: dir.to_string_lossy().into_owned(), reason: format!("Couldn't list sessions: {e}") });
            return;
        }
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let Some(file) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if path.is_dir() {
            if depth < 16 {
                let mut sub = folder.clone();
                sub.push(file);
                walk(&path, sub, depth + 1, out);
            }
            continue;
        }
        let Some(name) = file.strip_suffix(".ini") else { continue };
        if name == "__FolderData__" || (folder.is_empty() && name == "Default") {
            continue;
        }
        match super::read_source_file(&path) {
            Ok(text) => session(name, folder.clone(), &ini_values(&text), 16, out),
            Err(reason) => out.skipped.push(Skipped { name: name.into(), reason }),
        }
    }
}

pub(crate) fn parse_sessions_dir(dir: &Path) -> ImportPreview {
    let mut out = empty(&dir.to_string_lossy());
    walk(dir, Vec::new(), 0, &mut out);
    out
}

pub(crate) fn parse_xml(text: &str, origin: &str) -> Result<ImportPreview, String> {
    use quick_xml::events::Event;
    let bad = |e: &dyn std::fmt::Display| format!("Couldn't read the SecureCRT export: {e}");
    let name_of = |e: &quick_xml::events::BytesStart| -> Result<String, String> {
        Ok(match e.try_get_attribute("name").map_err(|e| bad(&e))? {
            Some(a) => a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| bad(&e))?.into_owned(),
            None => String::new(),
        })
    };
    let mut out = empty(origin);
    let mut reader = quick_xml::Reader::from_str(text);
    // Open `<key>`s: (name, the values directly inside it).
    let mut keys: Vec<(String, HashMap<String, String>)> = Vec::new();
    let mut value: Option<(String, String)> = None;
    loop {
        match reader.read_event().map_err(|e| bad(&e))? {
            Event::Start(e) if e.name().as_ref() == b"key" => keys.push((name_of(&e)?, HashMap::new())),
            Event::Start(e) if matches!(e.name().as_ref(), b"string" | b"dword") => value = Some((name_of(&e)?, String::new())),
            Event::Text(t) => {
                if let Some((_, v)) = value.as_mut() {
                    v.push_str(&t.decode().map_err(|e| bad(&e))?);
                }
            }
            Event::GeneralRef(r) => {
                if let Some((_, v)) = value.as_mut() {
                    let entity = r.decode().map_err(|e| bad(&e))?;
                    match r.resolve_char_ref().ok().flatten() {
                        Some(c) => v.push(c),
                        None => v.push_str(match entity.as_ref() {
                            "amp" => "&",
                            "lt" => "<",
                            "gt" => ">",
                            "quot" => "\"",
                            "apos" => "'",
                            _ => "",
                        }),
                    }
                }
            }
            Event::End(e) if matches!(e.name().as_ref(), b"string" | b"dword") => {
                if let (Some((name, v)), Some((_, values))) = (value.take(), keys.last_mut()) {
                    values.insert(name, v);
                }
            }
            Event::End(e) if e.name().as_ref() == b"key" => {
                let Some((name, values)) = keys.pop() else { continue };
                // Sessions are keys with a Hostname somewhere under the top-level "Sessions" key.
                let Some(root) = keys.iter().position(|(n, _)| n == "Sessions") else { continue };
                // Same as the folder walk: SecureCRT's template and per-folder settings aren't sessions.
                let template = name == "__FolderData__" || (name == "Default" && keys.len() == root + 1);
                if !template && (values.contains_key("Hostname") || values.contains_key("Protocol Name")) {
                    let folder = keys[root + 1..].iter().map(|(n, _)| n.clone()).collect();
                    session(&name, folder, &values, 10, &mut out);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !keys.is_empty() {
        return Err(bad(&"the file ends inside a <key>"));
    }
    Ok(out)
}

/// SecureCRT's session folder on this device, if it has any sessions.
pub(crate) fn detected(home: &Path) -> Option<ImportPreview> {
    let dir = if cfg!(windows) {
        dirs::config_dir()?.join("VanDyke").join("Config").join("Sessions")
    } else if cfg!(target_os = "macos") {
        dirs::config_dir()?.join("VanDyke").join("SecureCRT").join("Config").join("Sessions")
    } else {
        home.join(".vandyke").join("SecureCRT").join("Config").join("Sessions")
    };
    let found = parse_sessions_dir(&dir);
    (!found.hosts.is_empty() || !found.skipped.is_empty()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shetu-scrt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const WEB: &str = "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=10.0.0.4\r\nS:\"Username\"=deploy\r\nD:\"[SSH2] Port\"=00000016\r\nS:\"Identity Filename V2\"=C:\\keys\\id_rsa.pub::rawkey\r\nS:\"Firewall Name\"=None\r\n";

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts.iter().find(|h| h.name == name).unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn ini_session_fields() {
        let dir = temp_dir();
        std::fs::write(dir.join("web.ini"), WEB).unwrap();
        std::fs::write(dir.join("db.ini"), "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=db\nD:\"[SSH2] Port\"=0000115c\nS:\"Firewall Name\"=jump-proxy\n").unwrap();
        let p = parse_sessions_dir(&dir);
        assert_eq!(p.source, "securecrt");
        let web = host(&p, "web");
        assert_eq!((web.hostname.as_str(), web.port, web.user.as_deref()), ("10.0.0.4", 22, Some("deploy")));
        assert_eq!(host(&p, "db").port, 4444);
        assert!(p.skipped.contains(&Skipped { name: "db".into(), reason: "Proxy not imported".into() }));
        assert!(p.skipped.iter().all(|s| s.name != "web"));
    }

    #[test]
    fn identity_rawkey_and_pub_stripped() {
        let dir = temp_dir();
        std::fs::write(dir.join("web.ini"), WEB).unwrap();
        assert_eq!(host(&parse_sessions_dir(&dir), "web").key.as_ref().unwrap().path, r"C:\keys\id_rsa");
    }

    #[test]
    fn telnet_skipped() {
        let dir = temp_dir();
        std::fs::write(dir.join("switch.ini"), "S:\"Protocol Name\"=Telnet\nS:\"Hostname\"=10.9.9.9\n").unwrap();
        let p = parse_sessions_dir(&dir);
        assert!(p.hosts.is_empty());
        assert!(p.skipped.contains(&Skipped { name: "switch".into(), reason: "Telnet session".into() }));
    }

    #[test]
    fn dir_folders_and_folderdata_skipped() {
        let dir = temp_dir();
        std::fs::create_dir_all(dir.join("Prod/Web")).unwrap();
        std::fs::write(dir.join("Prod/Web/web.ini"), WEB).unwrap();
        std::fs::write(dir.join("Prod/__FolderData__.ini"), "S:\"Folder List\"=Web\n").unwrap();
        std::fs::write(dir.join("Default.ini"), WEB).unwrap();
        let p = parse_sessions_dir(&dir);
        assert_eq!(p.hosts.len(), 1, "{p:?}");
        assert_eq!(p.hosts[0].folder, vec!["Prod".to_string(), "Web".to_string()]);
        assert_eq!(p.hosts[0].id, "Prod/Web/web");
    }

    #[test]
    fn xml_export_nested_folders() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Options"><string name="Hostname">not-a-session</string></key>
  <key name="Sessions">
    <key name="Prod &amp; Co">
      <key name="web">
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">10.0.0.4</string>
        <string name="Username">deploy</string>
        <dword name="[SSH2] Port">2222</dword>
      </key>
    </key>
    <key name="root-one">
      <string name="Protocol Name">SSH2</string>
      <string name="Hostname">r.example.com</string>
    </key>
  </key>
</VanDyke>"#;
        let p = parse_xml(xml, "export.xml").unwrap();
        assert_eq!(p.hosts.len(), 2, "{p:?}");
        let web = host(&p, "web");
        assert_eq!(web.folder, vec!["Prod & Co".to_string()]);
        assert_eq!((web.port, web.user.as_deref()), (2222, Some("deploy")));
        assert!(host(&p, "root-one").folder.is_empty());
    }

    #[test]
    fn xml_default_template_and_folder_data_ignored() {
        let xml = r#"<VanDyke version="3.0"><key name="Sessions">
            <key name="Default"><string name="Protocol Name">SSH2</string></key>
            <key name="Prod"><key name="__FolderData__"><string name="Protocol Name">SSH2</string></key></key>
        </key></VanDyke>"#;
        let p = parse_xml(xml, "f").unwrap();
        assert!(p.hosts.is_empty() && p.skipped.is_empty(), "{p:?}");
    }

    #[test]
    fn malformed_xml_errors() {
        assert!(parse_xml("<VanDyke><key name=\"Sessions\"><key", "f").is_err());
    }
}
