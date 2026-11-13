//! Read `~/.ssh/config` (with `Include`; `Match` blocks dropped) into plain host records.

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};
use std::collections::HashSet;
use std::io::BufReader;
use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: u8 = 8;

/// Splits a config line into (lowercased keyword, rest); accepts `Key value` and `Key=value`.
fn split_keyword(line: &str) -> Option<(String, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let rest = line[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((line[..end].to_ascii_lowercase(), rest))
}

fn expand_include(arg: &str, home: &Path) -> PathBuf {
    let arg = arg.trim_matches('"');
    if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(arg).is_absolute() {
        PathBuf::from(arg)
    } else {
        home.join(".ssh").join(arg)
    }
}

fn inline_file(path: &Path, home: &Path, depth: u8, out: &mut String, match_files: &mut Vec<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let mut skipping = false;
    let mut had_match = false;
    for line in text.lines() {
        match split_keyword(line) {
            Some((kw, _)) if kw == "match" => {
                skipping = true;
                had_match = true;
                continue;
            }
            Some((kw, _)) if kw == "host" => skipping = false,
            Some((kw, rest)) if kw == "include" && !skipping => {
                if depth < MAX_INCLUDE_DEPTH {
                    for arg in rest.split_whitespace() {
                        let pattern = expand_include(arg, home);
                        let Ok(paths) = glob::glob(&pattern.to_string_lossy()) else {
                            continue;
                        };
                        for p in paths.flatten() {
                            inline_file(&p, home, depth + 1, out, match_files);
                        }
                    }
                }
                continue;
            }
            _ => {}
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    if had_match {
        match_files.push(path.to_string_lossy().into_owned());
    }
}

/// Main config with `Include`s inlined and `Match` blocks removed, plus the files that had `Match` blocks.
pub(crate) fn sanitize_config(home: &Path) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut match_files = Vec::new();
    inline_file(&home.join(".ssh").join("config"), home, 0, &mut out, &mut match_files);
    (out, match_files)
}

pub(crate) struct ParsedHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub proxy_jump: Option<String>,
    pub identity_files: Vec<PathBuf>,
}

pub(crate) fn parse_hosts(home: &Path) -> Result<(Vec<ParsedHost>, Vec<String>), String> {
    let (text, match_files) = sanitize_config(home);
    let mut reader = BufReader::new(text.as_bytes());
    let config = SshConfig::default()
        .home_dir(home)
        .parse(
            &mut reader,
            ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
        )
        .map_err(|e| format!("Could not parse SSH config: {e}"))?;

    let mut seen = HashSet::new();
    let mut hosts = Vec::new();
    for clause in config.get_hosts().iter().flat_map(|h| h.pattern.iter()) {
        let alias = &clause.pattern;
        if clause.negated || alias.contains(['*', '?']) || !seen.insert(alias.clone()) {
            continue;
        }
        let p = config.query(alias);
        hosts.push(ParsedHost {
            alias: alias.clone(),
            hostname: p.host_name.unwrap_or_else(|| alias.clone()),
            user: p.user,
            port: p.port.unwrap_or(22),
            proxy_jump: p.proxy_jump.map(|j| j.join(",")),
            identity_files: p.identity_file.unwrap_or_default(),
        });
    }
    Ok((hosts, match_files))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigKey {
    path: String,
    file_name: String,
    status: &'static str,
    fingerprint: Option<String>,
    key_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    alias: String,
    hostname: String,
    user: Option<String>,
    port: u16,
    proxy_jump: Option<String>,
    key: Option<SshConfigKey>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigPreview {
    hosts: Vec<SshConfigHost>,
    ignored_match_files: Vec<String>,
}

const DEFAULT_KEYS: [&str; 6] = [
    "id_ed25519",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    "id_rsa",
    "id_dsa",
];

/// Regular files up to 64 KiB only, so a FIFO, device or huge file can't hang or exhaust memory.
fn read_small_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn describe_key(path: &Path) -> SshConfigKey {
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut key = SshConfigKey {
        path: path.to_string_lossy().into_owned(),
        file_name,
        status: "unreadable",
        fingerprint: None,
        key_type: None,
    };
    if !path.exists() {
        key.status = "missing";
        return key;
    }
    let Some(content) = read_small_file(path) else {
        return key;
    };
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
            let mut pub_path = path.as_os_str().to_owned();
            pub_path.push(".pub");
            key.fingerprint = std::fs::read_to_string(pub_path)
                .ok()
                .and_then(|t| PublicKey::from_openssh(t.trim()).ok())
                .map(|p| p.fingerprint(HashAlg::Sha256).to_string());
        }
        Err(_) => {}
    }
    key
}

fn pick_key(host: &ParsedHost, home: &Path) -> Option<SshConfigKey> {
    let found = if host.identity_files.is_empty() {
        DEFAULT_KEYS.iter().map(|n| home.join(".ssh").join(n)).find(|p| p.exists())
    } else {
        host.identity_files.iter().find(|p| p.exists()).cloned()
            .or_else(|| host.identity_files.first().cloned())
    };
    found.map(|p| describe_key(&p))
}

pub(crate) fn preview(home: &Path) -> Result<SshConfigPreview, String> {
    let (parsed, ignored_match_files) = parse_hosts(home)?;
    let hosts = parsed
        .iter()
        .map(|h| SshConfigHost {
            alias: h.alias.clone(),
            hostname: h.hostname.clone(),
            user: h.user.clone(),
            port: h.port,
            proxy_jump: h.proxy_jump.clone(),
            key: pick_key(h, home),
        })
        .collect();
    Ok(SshConfigPreview { hosts, ignored_match_files })
}

pub(crate) fn read_key(home: &Path, path: &str) -> Result<String, String> {
    // Only files that parsed as private keys: never a general read-any-file command.
    let listed = preview(home)?.hosts.iter().any(|h| {
        h.key
            .as_ref()
            .is_some_and(|k| k.path == path && matches!(k.status, "ready" | "encrypted"))
    });
    if !listed {
        return Err("This file isn't a key listed in your SSH config".into());
    }
    read_small_file(Path::new(path)).ok_or_else(|| "Could not read key file".to_string())
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find your home folder".to_string())
}

#[tauri::command]
pub fn ssh_config_preview() -> Result<SshConfigPreview, String> {
    preview(&home()?)
}

#[tauri::command]
pub fn ssh_config_read_key(path: String) -> Result<String, String> {
    read_key(&home()?, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(files: &[(&str, &str)]) -> PathBuf {
        let home = std::env::temp_dir().join(format!("shetu-sshcfg-{}", uuid::Uuid::new_v4()));
        for (rel, body) in files {
            let p = home.join(".ssh").join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn find<'a>(hosts: &'a [ParsedHost], alias: &str) -> &'a ParsedHost {
        hosts.iter().find(|h| h.alias == alias).unwrap()
    }

    #[test]
    fn missing_config_is_empty() {
        let home = temp_home(&[]);
        let (hosts, matches) = parse_hosts(&home).unwrap();
        assert!(hosts.is_empty() && matches.is_empty());
    }

    #[test]
    fn lists_each_concrete_alias() {
        let home = temp_home(&[(
            "config",
            "Host web-*\n  User www\nHost a b\n  HostName 10.0.0.1\nHost !c d\n",
        )]);
        let (hosts, _) = parse_hosts(&home).unwrap();
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["a", "b", "d"]);
        assert_eq!(find(&hosts, "a").hostname, "10.0.0.1");
    }

    #[test]
    fn applies_host_star_defaults() {
        let home = temp_home(&[(
            "config",
            "Host prod\n  HostName p.example.com\nHost own\n  User me\nHost *\n  User deploy\n  Port 2222\n",
        )]);
        let (hosts, _) = parse_hosts(&home).unwrap();
        let prod = find(&hosts, "prod");
        assert_eq!(prod.user.as_deref(), Some("deploy"));
        assert_eq!(prod.port, 2222);
        assert_eq!(find(&hosts, "own").user.as_deref(), Some("me"));
    }

    #[test]
    fn follows_include_with_glob() {
        let home = temp_home(&[
            ("config", "Include config.d/*\n"),
            ("config.d/one", "Host one\n"),
            ("config.d/two", "Host two\n"),
        ]);
        let (hosts, _) = parse_hosts(&home).unwrap();
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert!(aliases.contains(&"one") && aliases.contains(&"two"));
    }

    #[test]
    fn drops_match_blocks() {
        let home = temp_home(&[(
            "config",
            "Host x\n  User xu\nMatch host *.corp\n  User corpuser\nHost y\n  HostName y.example.com\n",
        )]);
        let (hosts, matches) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "x").user.as_deref(), Some("xu"));
        assert_eq!(find(&hosts, "y").user, None);
        assert_eq!(
            matches,
            [home.join(".ssh").join("config").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn proxy_jump_kept_raw() {
        let home = temp_home(&[("config", "Host z\n  ProxyJump bastion,edge\n")]);
        let (hosts, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "z").proxy_jump.as_deref(), Some("bastion,edge"));
    }

    fn key_pem(passphrase: Option<&str>) -> (String, String) {
        use russh::keys::ssh_key::{getrandom::SysRng, rand_core::UnwrapErr, LineEnding};
        use russh::keys::{Algorithm, PrivateKey};
        let mut rng = UnwrapErr(SysRng);
        let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let public = key.public_key().to_openssh().unwrap();
        if let Some(pw) = passphrase {
            key = key.encrypt(&mut rng, pw).unwrap();
        }
        (key.to_openssh(LineEnding::LF).unwrap().to_string(), public)
    }

    fn only_key(home: &Path) -> SshConfigKey {
        let mut p = preview(home).unwrap();
        p.hosts.remove(0).key.unwrap()
    }

    #[test]
    fn configured_key_ready_with_fingerprint() {
        let (pem, _) = key_pem(None);
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/work\n"), ("work", &pem)]);
        let k = only_key(&home);
        assert_eq!(k.status, "ready");
        assert!(k.fingerprint.unwrap().starts_with("SHA256:"));
        assert_eq!(k.file_name, "work");
    }

    #[test]
    fn falls_back_to_default_key() {
        let (pem, _) = key_pem(None);
        let home = temp_home(&[("config", "Host a\n  HostName h\n"), ("id_ed25519", &pem)]);
        assert!(only_key(&home).path.ends_with("id_ed25519"));
    }

    #[test]
    fn encrypted_key_uses_pub_fingerprint() {
        let (pem, public) = key_pem(Some("pw"));
        let home = temp_home(&[
            ("config", "Host a\n  IdentityFile ~/.ssh/enc\n"),
            ("enc", &pem),
            ("enc.pub", &public),
        ]);
        let k = only_key(&home);
        let want = russh::keys::PublicKey::from_openssh(&public)
            .unwrap()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        assert_eq!(k.status, "encrypted");
        assert_eq!(k.fingerprint.unwrap(), want);
    }

    #[test]
    fn missing_key_reported() {
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/gone\n")]);
        assert_eq!(only_key(&home).status, "missing");
    }

    #[test]
    fn unreadable_key_is_reported() {
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/junk\n"), ("junk", "not a key")]);
        assert_eq!(only_key(&home).status, "unreadable");
    }

    #[test]
    fn read_key_only_allows_listed_paths() {
        let (pem, _) = key_pem(None);
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/work\n"), ("work", &pem)]);
        let k = only_key(&home);
        assert_eq!(read_key(&home, &k.path).unwrap(), pem);
        let cfg = home.join(".ssh/config");
        assert!(read_key(&home, cfg.to_str().unwrap()).is_err());
    }

    #[test]
    fn read_key_rejects_listed_non_key_file() {
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/junk\n"), ("junk", "not a key")]);
        let k = only_key(&home);
        assert!(read_key(&home, &k.path).is_err());
    }

    #[test]
    fn non_regular_file_is_unreadable() {
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/somedir\n")]);
        std::fs::create_dir_all(home.join(".ssh/somedir")).unwrap();
        let k = only_key(&home);
        assert_eq!(k.status, "unreadable");
        assert!(read_key(&home, &k.path).is_err());
    }
}
