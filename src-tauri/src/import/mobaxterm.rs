//! MobaXterm sessions (`MobaXterm.ini` or a `.mxtsessions` export). `SubRep` folders become groups.

use super::{ImportPreview, ImportedHost, Skipped};
use std::path::Path;

/// A key path with MobaXterm's placeholders replaced.
fn key_path(raw: &str, home: &Path) -> String {
    let raw = raw.replace("_CurrentDrive_", "C");
    match raw.strip_prefix("_ProfileDir_") {
        Some(rest) => format!("{}{rest}", home.display()),
        None => raw,
    }
}

fn session(name: &str, value: &str, folder: &[String], home: &Path, out: &mut ImportPreview) {
    // `#<icon>#<type>%host%port%user%…#<terminal settings>#…`; type 0 is SSH (the icon can be changed).
    let fields: Vec<&str> = value.split('#').nth(2).unwrap_or("").split('%').collect();
    let field = |i: usize| fields.get(i).map(|v| v.trim()).filter(|v| !v.is_empty());
    if fields.first() != Some(&"0") {
        out.skipped.push(Skipped { name: name.into(), reason: "Not an SSH session".into() });
        return;
    }
    let Some(hostname) = field(1) else {
        out.skipped.push(Skipped { name: name.into(), reason: "No host name".into() });
        return;
    };
    if field(8).is_some() {
        out.skipped.push(Skipped { name: name.into(), reason: "SSH gateway not imported".into() });
    }
    let id = folder.iter().map(String::as_str).chain([name]).collect::<Vec<_>>().join("/");
    out.hosts.push(ImportedHost {
        id,
        name: name.into(),
        hostname: hostname.into(),
        port: field(2).and_then(|p| p.parse().ok()).unwrap_or(22),
        user: field(3).map(String::from),
        key: field(14).map(|k| super::describe_key(Path::new(&key_path(k, home)))),
        jump: None,
        folder: folder.to_vec(),
        tags: Vec::new(),
    });
}

pub(crate) fn parse(text: &str, origin: &str, home: &Path) -> ImportPreview {
    let mut out = ImportPreview { source: "mobaxterm".into(), origin: origin.into(), hosts: Vec::new(), skipped: Vec::new() };
    for (section, entries) in super::ini::sections(text) {
        if section != "Bookmarks" && !section.starts_with("Bookmarks_") {
            continue;
        }
        let folder: Vec<String> = entries
            .iter()
            .find(|(k, _)| k == "SubRep")
            .map(|(_, v)| v.split('\\').map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect())
            .unwrap_or_default();
        for (name, value) in &entries {
            if name == "SubRep" || name == "ImgNum" {
                continue;
            }
            session(name, value, &folder, home, &mut out);
        }
    }
    out
}

/// MobaXterm's own sessions (Windows only), if any.
pub(crate) fn detected(home: &Path) -> Option<ImportPreview> {
    if !cfg!(windows) {
        return None;
    }
    let candidates = [dirs::document_dir().map(|d| d.join("MobaXterm")), dirs::config_dir().map(|d| d.join("MobaXterm"))];
    let ini = candidates.into_iter().flatten().map(|d| d.join("MobaXterm.ini")).find(|p| p.is_file())?;
    let text = super::read_source_file(&ini).ok()?;
    let found = parse(&text, &ini.to_string_lossy(), home);
    (!found.hosts.is_empty() || !found.skipped.is_empty()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic SSH line: host, port, user, gateway (8), key (14), then the terminal group.
    fn ssh(host: &str, port: &str, user: &str, gateway: &str, key: &str) -> String {
        format!("#109#0%{host}%{port}%{user}%%-1%-1%%{gateway}%22%%0%0%0%{key}%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30#0# #-1")
    }

    fn sample() -> String {
        format!(
            "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\nweb={}\r\nrdp=#91#4%10.0.0.9%3389%admin%0\r\n\r\n[Bookmarks_1]\r\nSubRep=Prod\\Web\r\nImgNum=41\r\ndb={}\r\ninner={}\r\nprofile={}\r\n",
            ssh("10.0.0.4", "2222", "deploy", "", "_CurrentDrive_:\\keys\\a.ppk"),
            ssh("db.example.com", "22", "", "", ""),
            ssh("10.1.0.5", "22", "root", "bastion.example.com", ""),
            ssh("p.example.com", "22", "me", "", "_ProfileDir_\\.ssh\\id_ed25519"),
        )
    }

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts.iter().find(|h| h.name == name).unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn ssh_session_fields() {
        let p = parse(&sample(), "MobaXterm.ini", Path::new("/home/u"));
        assert_eq!(p.source, "mobaxterm");
        let web = host(&p, "web");
        assert_eq!((web.hostname.as_str(), web.port, web.user.as_deref()), ("10.0.0.4", 2222, Some("deploy")));
        assert_eq!(web.key.as_ref().unwrap().path, r"C:\keys\a.ppk");
        assert!(web.folder.is_empty());
        let db = host(&p, "db");
        assert_eq!((db.port, db.user.as_deref(), db.key.is_none()), (22, None, true));
    }

    #[test]
    fn folders_from_subrep() {
        let p = parse(&sample(), "f", Path::new("/home/u"));
        assert_eq!(host(&p, "db").folder, vec!["Prod".to_string(), "Web".to_string()]);
        assert_eq!(host(&p, "db").id, "Prod/Web/db");
    }

    #[test]
    fn non_ssh_skipped() {
        let p = parse(&sample(), "f", Path::new("/home/u"));
        assert!(p.hosts.iter().all(|h| h.name != "rdp"));
        assert!(p.skipped.contains(&Skipped { name: "rdp".into(), reason: "Not an SSH session".into() }));
    }

    #[test]
    fn gateway_noted() {
        let p = parse(&sample(), "f", Path::new("/home/u"));
        assert_eq!(host(&p, "inner").hostname, "10.1.0.5");
        assert!(p.skipped.contains(&Skipped { name: "inner".into(), reason: "SSH gateway not imported".into() }));
    }

    #[test]
    fn profile_dir_expands() {
        let p = parse(&sample(), "f", Path::new("/home/u"));
        let key = host(&p, "profile").key.as_ref().unwrap().path.clone();
        assert!(key.starts_with("/home/u") && key.ends_with("id_ed25519"), "{key}");
    }
}
