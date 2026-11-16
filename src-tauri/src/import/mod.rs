//! Importing hosts from other SSH clients: one model, one adapter per source.

pub(crate) mod encoding;
pub(crate) mod ini;
pub(crate) mod putty;
pub(crate) mod termius_csv;
pub(crate) mod winscp;

use serde::Serialize;
use std::path::{Path, PathBuf};

/// A key file a session points at, as the preview shows it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportKey {
    pub path: String,
    pub file_name: String,
    /// ready | encrypted | missing | unreadable
    pub status: &'static str,
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    /// The source's own id for the session, used by `jump`.
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub user: Option<String>,
    pub key: Option<ImportKey>,
    /// Another row's `id`.
    pub jump: Option<String>,
    /// Folder path from the root, e.g. ["Prod", "Web"].
    pub folder: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ImportPreview {
    pub source: String,
    pub origin: String,
    pub hosts: Vec<ImportedHost>,
    pub skipped: Vec<Skipped>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Detected {
    pub source: String,
    pub origin: String,
}

const KEY_LIMIT: u64 = 64 * 1024;
const SOURCE_LIMIT: u64 = 5 * 1024 * 1024;

/// Regular files up to `limit` only, so a FIFO, device or huge file can't hang or exhaust memory.
fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} isn't a file", path.display()));
    }
    if meta.len() > limit {
        return Err(format!("{} is too large ({} MB at most)", path.display(), limit.div_ceil(1024 * 1024)));
    }
    std::fs::read(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))
}

pub(crate) fn read_small_file(path: &Path) -> Option<String> {
    read_limited(path, KEY_LIMIT).ok().and_then(|b| String::from_utf8(b).ok())
}

/// A picked or detected source file as text: UTF-16 (with BOM) decoded, a UTF-8 BOM dropped.
pub(crate) fn read_source_file(path: &Path) -> Result<String, String> {
    let bytes = read_limited(path, SOURCE_LIMIT)?;
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    Ok(match bytes.as_slice() {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, true),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, false),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        all => String::from_utf8_lossy(all).into_owned(),
    })
}

pub(crate) fn describe_key(path: &Path) -> ImportKey {
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut key = ImportKey {
        path: path.to_string_lossy().into_owned(),
        file_name,
        status: "unreadable",
        fingerprint: None,
        key_type: None,
    };
    // Never touch a network path: on Windows, opening one sends the user's NTLM hash to that server.
    let raw = key.path.as_str();
    if raw.starts_with(r"\\") || (cfg!(windows) && raw.starts_with("//")) {
        return key;
    }
    if !path.exists() {
        key.status = "missing";
        return key;
    }
    let Some(mut content) = read_small_file(path) else {
        return key;
    };
    if content.trim_start().starts_with("PuTTY-User-Key-File-") {
        if !content.lines().any(|l| l.trim() == "Encryption: none") {
            // The public half is in the clear, but matching it needs the full key; ask once instead.
            key.status = "encrypted";
            return key;
        }
        match crate::keys::convert_ppk_inner(content, None) {
            Ok(openssh) => content = openssh,
            Err(_) => return key,
        }
    }
    match russh::keys::decode_secret_key(&content, None) {
        Ok(k) => {
            if let Ok(meta) = crate::keys::metadata_for_key(&k) {
                key.status = "ready";
                key.fingerprint = Some(meta.fingerprint);
                key.key_type = Some(meta.key_type);
            }
        }
        Err(russh::keys::Error::KeyIsEncrypted) => {
            key.status = "encrypted";
            // OpenSSH-format keys keep the public half unencrypted; legacy PEM won't parse and stays unmatched.
            if let Ok(k) = russh::keys::ssh_key::PrivateKey::from_openssh(&content) {
                if let Ok(meta) = crate::keys::metadata_for_key(&k) {
                    key.fingerprint = Some(meta.fingerprint);
                    key.key_type = Some(meta.key_type);
                }
            }
        }
        Err(_) => {}
    }
    key
}

pub(crate) fn preview_for(source: &str, path: Option<&Path>, home: &Path) -> Result<ImportPreview, String> {
    let file = |path: &Path| read_source_file(path).map(|text| (text, path.to_string_lossy().into_owned()));
    match (source, path) {
        ("ssh_config", _) => crate::ssh_config_import::to_preview(home),
        ("putty", Some(p)) => file(p).map(|(text, origin)| putty::parse_reg(&text, &origin)),
        ("putty", None) => putty::detected(home).ok_or_else(|| "No PuTTY sessions found".into()),
        ("winscp", Some(p)) => file(p).map(|(text, origin)| winscp::parse_ini(&text, &origin)),
        ("winscp", None) => winscp::detected().ok_or_else(|| "No WinSCP sites found".into()),
        ("termius_csv", Some(p)) => file(p).and_then(|(text, origin)| termius_csv::parse_csv(&text, &origin)),
        ("termius_csv", None) => Err("Choose a CSV file to import".into()),
        _ => Err("Unknown import source".into()),
    }
}

pub(crate) fn read_key_for(source: &str, path: Option<&Path>, home: &Path, key_path: &str) -> Result<String, String> {
    let listed = preview_for(source, path, home)?.hosts.iter().any(|h| {
        h.key
            .as_ref()
            .is_some_and(|k| k.path == key_path && matches!(k.status, "ready" | "encrypted"))
    });
    if !listed {
        return Err("This file isn't a key listed in the import".into());
    }
    read_small_file(Path::new(key_path)).ok_or_else(|| "Could not read key file".to_string())
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find your home folder".to_string())
}

/// Sources with data in their usual place on this device.
#[tauri::command]
pub async fn import_detect() -> Vec<Detected> {
    home().map(|h| detect(&h)).unwrap_or_default()
}

pub(crate) fn detect(home: &Path) -> Vec<Detected> {
    let mut found = Vec::new();
    if home.join(".ssh").join("config").is_file() {
        found.push(Detected { source: "ssh_config".into(), origin: "~/.ssh/config".into() });
    }
    if let Some(p) = putty::detected(home) {
        found.push(Detected { source: "putty".into(), origin: p.origin });
    }
    if let Some(p) = winscp::detected() {
        found.push(Detected { source: "winscp".into(), origin: p.origin });
    }
    found
}

// async: file and registry reads stay off the main thread.
#[tauri::command]
pub async fn import_preview(source: String, path: Option<String>) -> Result<ImportPreview, String> {
    preview_for(&source, path.as_deref().map(Path::new), &home()?)
}

/// Reads a key file only if `source`'s own preview lists it: never a general read-any-file command.
#[tauri::command]
pub async fn import_read_key(source: String, path: Option<String>, key_path: String) -> Result<String, String> {
    read_key_for(&source, path.as_deref().map(Path::new), &home()?, &key_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shetu-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ssh_home(config: &str) -> PathBuf {
        let home = temp_dir();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/config"), config).unwrap();
        home
    }

    #[test]
    fn ssh_config_maps_to_model() {
        let home = ssh_home(
            "Host web\n  HostName 10.0.0.4\n  User deploy\n  Port 2222\nHost app\n  ProxyJump web\nMatch host *.corp\n  User x\n",
        );
        let p = preview_for("ssh_config", None, &home).unwrap();
        assert_eq!(p.source, "ssh_config");
        let web = p.hosts.iter().find(|h| h.id == "web").unwrap();
        assert_eq!((web.name.as_str(), web.hostname.as_str(), web.port), ("web", "10.0.0.4", 2222));
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert!(web.folder.is_empty());
        let app = p.hosts.iter().find(|h| h.id == "app").unwrap();
        assert_eq!(app.jump.as_deref(), Some("web"));
        assert!(p
            .skipped
            .iter()
            .any(|s| s.reason == "Match blocks aren't supported and were ignored"));
    }

    #[test]
    fn ppk_unencrypted_is_ready_with_fingerprint() {
        let dir = temp_dir();
        let path = dir.join("a.ppk");
        std::fs::write(&path, crate::keys::tests::ppk_fixture(3, None)).unwrap();
        let k = describe_key(&path);
        assert_eq!(k.status, "ready");
        assert!(k.fingerprint.is_some());
    }

    #[test]
    fn ppk_encrypted_is_encrypted() {
        let dir = temp_dir();
        let path = dir.join("b.ppk");
        std::fs::write(&path, crate::keys::tests::ppk_fixture(2, Some("pw"))).unwrap();
        let k = describe_key(&path);
        assert_eq!(k.status, "encrypted");
        assert_eq!(k.fingerprint, None);
    }

    #[test]
    fn read_key_refuses_unlisted_path() {
        let home = ssh_home("Host web\n  HostName w\n");
        let other = home.join("secret.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(read_key_for("ssh_config", None, &home, other.to_str().unwrap()).is_err());
    }

    #[test]
    fn picked_file_over_limit_is_refused() {
        let dir = temp_dir();
        let big = dir.join("big.reg");
        std::fs::write(&big, vec![b'a'; (SOURCE_LIMIT + 1) as usize]).unwrap();
        let err = read_source_file(&big).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(read_source_file(&dir).is_err());
    }

    #[test]
    fn utf16_bom_is_decoded() {
        let dir = temp_dir();
        let path = dir.join("u.reg");
        let mut bytes = vec![0xFF, 0xFE];
        for u in "a=b".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(read_source_file(&path).unwrap(), "a=b");
        std::fs::write(&path, b"\xEF\xBB\xBFx=y").unwrap();
        assert_eq!(read_source_file(&path).unwrap(), "x=y");
    }

    #[test]
    fn network_key_paths_are_never_opened() {
        // On Windows, touching a UNC path sends the user's NTLM hash to that server.
        let k = describe_key(Path::new(r"\\attacker.example\s\k.ppk"));
        assert_eq!(k.status, "unreadable");
    }

    #[test]
    fn unknown_source_errors() {
        let home = temp_dir();
        assert_eq!(preview_for("nope", None, &home).unwrap_err(), "Unknown import source");
    }
}
