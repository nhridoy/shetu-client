//! Read `~/.ssh/config` (with `Include`; `Match` blocks dropped) into plain host records.

// shortcut: remove once Task 2 wires the commands.
#![allow(dead_code)]

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
}
