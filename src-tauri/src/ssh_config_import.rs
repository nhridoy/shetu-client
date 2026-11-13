//! Read `~/.ssh/config` (with `Include`; `Match` blocks dropped) into plain host records.

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

fn read_lossy(path: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

/// Splits Include arguments: double quotes group (and are removed); an unquoted `#` token starts a comment.
fn include_args(rest: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut chars = rest.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '#' {
            break;
        } else {
            let (mut tok, mut quoted) = (String::new(), false);
            while let Some(&c) = chars.peek() {
                if c == '"' {
                    quoted = !quoted;
                } else if c.is_whitespace() && !quoted {
                    break;
                } else {
                    tok.push(c);
                }
                chars.next();
            }
            args.push(tok);
        }
    }
    args
}

#[derive(Default)]
struct Inlined {
    text: String,
    match_files: Vec<String>,
    scoped_files: Vec<String>,
}

/// `scoped` is the enclosing (non-`*`) Host line when inlining an Include found under it.
fn inline_file(path: &Path, home: &Path, depth: u8, scoped: Option<&str>, out: &mut Inlined) {
    if let Ok(text) = read_lossy(path) {
        inline_text(&text, path, home, depth, scoped, out);
    }
}

fn inline_text(text: &str, path: &Path, home: &Path, depth: u8, scoped: Option<&str>, out: &mut Inlined) {
    let mut skipping = false;
    let mut had_match = false;
    // Host line whose scope is current; None means all hosts.
    let mut scope: Option<String> = scoped.map(String::from);
    for line in text.lines() {
        match split_keyword(line) {
            Some((kw, _)) if kw == "match" || (kw == "host" && scoped.is_some()) => {
                if scoped.is_some() {
                    out.scoped_files.push(path.to_string_lossy().into_owned());
                    return;
                }
                skipping = true;
                had_match = true;
                continue;
            }
            Some((kw, rest)) if kw == "host" => {
                skipping = false;
                scope = (rest.trim() != "*").then(|| line.to_string());
            }
            Some((kw, rest)) if kw == "include" && !skipping => {
                if depth < MAX_INCLUDE_DEPTH {
                    for arg in include_args(rest) {
                        let pattern = expand_include(&arg, home);
                        let Ok(paths) = glob::glob(&pattern.to_string_lossy()) else {
                            continue;
                        };
                        for p in paths.flatten() {
                            inline_file(&p, home, depth + 1, scope.as_deref(), out);
                        }
                    }
                    // Return to the enclosing scope after the included lines.
                    out.text.push_str(scope.as_deref().unwrap_or("Host *"));
                    out.text.push('\n');
                }
                continue;
            }
            _ => {}
        }
        if !skipping {
            out.text.push_str(line);
            out.text.push('\n');
        }
    }
    if had_match {
        out.match_files.push(path.to_string_lossy().into_owned());
    }
}

/// Main config with `Include`s inlined and `Match` blocks removed, plus the files that had `Match`
/// blocks and the files whose Host blocks were ignored because they sit under a Host entry.
pub(crate) fn sanitize_config(home: &Path) -> Result<(String, Vec<String>, Vec<String>), String> {
    let mut out = Inlined::default();
    let path = home.join(".ssh").join("config");
    match read_lossy(&path) {
        Ok(text) => inline_text(&text, &path, home, 0, None, &mut out),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Couldn't read ~/.ssh/config: {e}")),
    }
    Ok((out.text, out.match_files, out.scoped_files))
}

pub(crate) struct ParsedHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub proxy_jump: Option<String>,
    pub identity_files: Vec<PathBuf>,
}

pub(crate) fn parse_hosts(home: &Path) -> Result<(Vec<ParsedHost>, Vec<String>, Vec<String>), String> {
    let (text, match_files, scoped_files) = sanitize_config(home)?;
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
            // `ProxyJump none` means "no jump host" in OpenSSH.
            proxy_jump: p
                .proxy_jump
                .filter(|j| !(j.len() == 1 && j[0].trim().eq_ignore_ascii_case("none")))
                .map(|j| j.join(",")),
            identity_files: p.identity_file.unwrap_or_default(),
        });
    }
    Ok((hosts, match_files, scoped_files))
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
    ignored_scoped_include_files: Vec<String>,
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
    let (parsed, ignored_match_files, ignored_scoped_include_files) = parse_hosts(home)?;
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
    Ok(SshConfigPreview { hosts, ignored_match_files, ignored_scoped_include_files })
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
        let (hosts, matches, _) = parse_hosts(&home).unwrap();
        assert!(hosts.is_empty() && matches.is_empty());
    }

    #[test]
    fn lists_each_concrete_alias() {
        let home = temp_home(&[(
            "config",
            "Host web-*\n  User www\nHost a b\n  HostName 10.0.0.1\nHost !c d\n",
        )]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
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
        let (hosts, _, _) = parse_hosts(&home).unwrap();
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
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert!(aliases.contains(&"one") && aliases.contains(&"two"));
    }

    #[test]
    fn drops_match_blocks() {
        let home = temp_home(&[(
            "config",
            "Host x\n  User xu\nMatch host *.corp\n  User corpuser\nHost y\n  HostName y.example.com\n",
        )]);
        let (hosts, matches, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "x").user.as_deref(), Some("xu"));
        assert_eq!(find(&hosts, "y").user, None);
        assert_eq!(
            matches,
            [home.join(".ssh").join("config").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn proxy_jump_none_means_no_jump() {
        let home = temp_home(&[(
            "config",
            "Host bastion\n  HostName b.example.com\n  ProxyJump none\nHost web\n  HostName w.example.com\nHost *\n  ProxyJump bastion\n",
        )]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "bastion").proxy_jump, None);
        assert_eq!(find(&hosts, "web").proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn invalid_utf8_in_config_still_parses() {
        let home = temp_home(&[]);
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let mut bytes = b"# caf\xff\nHost a\n  HostName a.example.com\n".to_vec();
        bytes.push(b'\n');
        std::fs::write(home.join(".ssh").join("config"), bytes).unwrap();
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "a").hostname, "a.example.com");
    }

    #[test]
    fn unreadable_main_config_is_an_error() {
        let home = temp_home(&[]);
        std::fs::create_dir_all(home.join(".ssh").join("config")).unwrap();
        let err = parse_hosts(&home).err().unwrap();
        assert!(err.starts_with("Couldn't read ~/.ssh/config:"), "{err}");
    }

    #[test]
    fn proxy_jump_kept_raw() {
        let home = temp_home(&[("config", "Host z\n  ProxyJump bastion,edge\n")]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
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

    fn own_fingerprint(pem: &str) -> String {
        russh::keys::ssh_key::PrivateKey::from_openssh(pem)
            .unwrap()
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string()
    }

    #[test]
    fn encrypted_key_fingerprint_comes_from_key_not_pub() {
        let (pem, _) = key_pem(Some("pw"));
        let (_, other_public) = key_pem(None);
        let home = temp_home(&[
            ("config", "Host a\n  IdentityFile ~/.ssh/enc\n"),
            ("enc", &pem),
            ("enc.pub", &other_public),
        ]);
        let k = only_key(&home);
        assert_eq!(k.status, "encrypted");
        assert_eq!(k.fingerprint.unwrap(), own_fingerprint(&pem));
        assert_eq!(k.key_type.as_deref(), Some("ed25519"));
    }

    #[test]
    fn encrypted_key_without_pub_has_fingerprint() {
        let (pem, _) = key_pem(Some("pw"));
        let home = temp_home(&[("config", "Host a\n  IdentityFile ~/.ssh/enc\n"), ("enc", &pem)]);
        let k = only_key(&home);
        assert_eq!(k.status, "encrypted");
        assert_eq!(k.fingerprint.unwrap(), own_fingerprint(&pem));
    }

    #[test]
    fn include_with_quoted_path_containing_space() {
        let home = temp_home(&[
            ("config", "Include \"config.d/company hosts.conf\" # trailing\n"),
            ("config.d/company hosts.conf", "Host corp\n"),
        ]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        assert!(hosts.iter().any(|h| h.alias == "corp"));
    }

    #[test]
    fn include_under_host_does_not_leak_to_other_hosts() {
        let home = temp_home(&[
            ("config", "Host prod\n  Include scoped.conf\nHost dev\n  HostName dev.example.com\n"),
            ("scoped.conf", "User produser\nHost *\n  HostName wrong.example.com\n"),
        ]);
        let (hosts, _, scoped) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "prod").user.as_deref(), Some("produser"));
        assert_eq!(find(&hosts, "dev").hostname, "dev.example.com");
        assert_eq!(scoped, [home.join(".ssh/scoped.conf").to_string_lossy().into_owned()]);
    }

    #[test]
    fn lines_after_include_stay_in_parent_scope() {
        let home = temp_home(&[
            ("config", "Host prod\n  HostName p.example.com\n  Include more.conf\n  Port 2200\n"),
            ("more.conf", "Host other\n  HostName o.example.com\n"),
        ]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "prod").port, 2200);
        assert!(!hosts.iter().any(|h| h.alias == "other"));
    }

    #[test]
    fn top_level_include_restores_global_scope() {
        let home = temp_home(&[
            ("config", "Include a.conf\nUser bob\nHost y\n  HostName y.example.com\n"),
            ("a.conf", "Host x\n  HostName x.example.com\n"),
        ]);
        let (hosts, _, _) = parse_hosts(&home).unwrap();
        assert_eq!(find(&hosts, "x").user.as_deref(), Some("bob"));
        assert_eq!(find(&hosts, "y").user.as_deref(), Some("bob"));
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
