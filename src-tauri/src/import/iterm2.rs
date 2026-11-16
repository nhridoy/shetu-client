//! iTerm2 profiles whose command is `ssh …` (JSON export, DynamicProfiles, or the prefs plist).

use super::{ImportPreview, ImportedHost};
use std::path::Path;

#[derive(Debug, PartialEq)]
pub(crate) struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub key: Option<String>,
    pub jump: Option<String>,
}

/// Words as a shell would split them for plain quoting (no expansion); an open quote runs to the end.
fn words(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in cmd.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
                started = false;
            }
            (None, c) => word.push(c),
        }
    }
    if started || !word.is_empty() {
        out.push(word);
    }
    out
}

/// ssh flags that take a value (`-p 22` or `-p22`).
const WITH_VALUE: &str = "pliJoLRDFEcmbeOQSWwBI";

/// `ssh [flags] [user@]host [flags] [command]` into its target; None when it isn't an ssh command.
pub(crate) fn parse_ssh_command(cmd: &str) -> Option<SshTarget> {
    let words = words(cmd);
    let (program, args) = words.split_first()?;
    if !(program == "ssh" || program.ends_with("/ssh")) {
        return None;
    }
    let mut target = SshTarget { user: None, host: String::new(), port: None, key: None, jump: None };
    let mut destination: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        let Some(flags) = arg.strip_prefix('-').filter(|f| !f.is_empty()) else {
            if destination.is_some() {
                break; // the remote command
            }
            destination = Some(arg.clone());
            continue;
        };
        let flag = flags.chars().next()?;
        if !WITH_VALUE.contains(flag) {
            continue; // e.g. -4tA
        }
        let value = if flags.len() > 1 {
            flags[flag.len_utf8()..].to_string()
        } else {
            let v = args.get(i)?.clone();
            i += 1;
            v
        };
        match flag {
            'p' => target.port = value.parse().ok(),
            'l' => target.user = Some(value),
            'i' => target.key = Some(value),
            // Only one hop is imported; a chain is left to the summary.
            'J' if !value.contains(',') => target.jump = Some(value),
            _ => {}
        }
    }
    let destination = destination?;
    let (user, host) = match destination.rsplit_once('@') {
        Some((u, h)) => (Some(u.to_string()), h.to_string()),
        None => (None, destination),
    };
    if user.is_some() {
        target.user = user;
    }
    target.host = host;
    (!target.host.is_empty()).then_some(target)
}

pub(crate) fn parse_profiles(profiles: &[serde_json::Value], origin: &str) -> ImportPreview {
    let mut out = ImportPreview { source: "iterm2".into(), origin: origin.into(), hosts: Vec::new(), skipped: Vec::new() };
    for profile in profiles {
        let text = |k: &str| profile[k].as_str().map(str::trim).filter(|s| !s.is_empty());
        // Most profiles are local shells; only ssh commands are hosts, the rest aren't worth listing.
        // iTerm2 ignores Command unless Custom Command is on; "No" means a login shell.
        let Some(command) = text("Command").filter(|_| text("Custom Command") != Some("No")) else { continue };
        let Some(t) = parse_ssh_command(command) else { continue };
        let name = text("Name").unwrap_or(&t.host).to_string();
        out.hosts.push(ImportedHost {
            id: text("Guid").map_or_else(|| name.clone(), String::from),
            name,
            hostname: t.host,
            port: t.port.unwrap_or(22),
            user: t.user,
            key: t.key.map(|k| {
                let path = match k.strip_prefix("~/") {
                    Some(rest) => dirs::home_dir().map_or(k.clone(), |h| h.join(rest).to_string_lossy().into_owned()),
                    None => k,
                };
                super::describe_key(Path::new(&path))
            }),
            jump: t.jump,
            folder: Vec::new(),
            tags: profile["Tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str().map(String::from))
                .collect(),
        });
    }
    out
}

/// `{"Profiles": [...]}`, as iTerm2's JSON export and DynamicProfiles files hold them.
pub(crate) fn parse_json(text: &str, origin: &str) -> Result<ImportPreview, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Couldn't read the iTerm2 profiles: {e}"))?;
    let profiles = value["Profiles"].as_array().map(Vec::as_slice).unwrap_or_default();
    Ok(parse_profiles(profiles, origin))
}

/// iTerm2's profiles on this Mac: its prefs plus DynamicProfiles, if any are ssh hosts.
pub(crate) fn detected(home: &Path) -> Option<ImportPreview> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let mut profiles: Vec<serde_json::Value> = Vec::new();
    let prefs = home.join("Library/Preferences/com.googlecode.iterm2.plist");
    if let Ok(bytes) = super::read_limited(&prefs, super::SOURCE_LIMIT) {
        if let Ok(value) = plist::Value::from_reader(std::io::Cursor::new(bytes)) {
            if let Ok(json) = serde_json::to_value(&value) {
                profiles.extend(json["New Bookmarks"].as_array().cloned().unwrap_or_default());
            }
        }
    }
    let dynamic = home.join("Library/Application Support/iTerm2/DynamicProfiles");
    for entry in std::fs::read_dir(dynamic).into_iter().flatten().flatten() {
        if let Ok(text) = super::read_source_file(&entry.path()) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                profiles.extend(value["Profiles"].as_array().cloned().unwrap_or_default());
            }
        }
    }
    let found = parse_profiles(&profiles, "iTerm2 profiles");
    (!found.hosts.is_empty()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(user: Option<&str>, host: &str, port: Option<u16>, key: Option<&str>, jump: Option<&str>) -> SshTarget {
        SshTarget { user: user.map(String::from), host: host.into(), port, key: key.map(String::from), jump: jump.map(String::from) }
    }

    #[test]
    fn ssh_command_variants() {
        assert_eq!(parse_ssh_command("ssh deploy@10.0.0.4"), Some(target(Some("deploy"), "10.0.0.4", None, None, None)));
        assert_eq!(
            parse_ssh_command(r#"ssh -p 2222 -i "~/k a" web"#),
            Some(target(None, "web", Some(2222), Some("~/k a"), None))
        );
        assert_eq!(
            parse_ssh_command("ssh -l root -o StrictHostKeyChecking=no -L 8080:localhost:80 host uptime"),
            Some(target(Some("root"), "host", None, None, None))
        );
        assert_eq!(parse_ssh_command("ssh -J bastion inner"), Some(target(None, "inner", None, None, Some("bastion"))));
        assert_eq!(parse_ssh_command("ssh -J a,b inner"), Some(target(None, "inner", None, None, None)));
        assert_eq!(parse_ssh_command("/usr/bin/ssh -4tA h"), Some(target(None, "h", None, None, None)));
        assert_eq!(parse_ssh_command("bash"), None);
        assert_eq!(parse_ssh_command("ssh -p"), None);
        assert_eq!(parse_ssh_command("ssh 'unterminated"), Some(target(None, "unterminated", None, None, None)));
    }

    #[test]
    fn json_profiles_mapped() {
        let p = parse_profiles(
            &[
                json!({"Name": "web", "Guid": "g1", "Custom Command": "Yes", "Command": "ssh deploy@10.0.0.4 -p 2222", "Tags": ["prod", "web"]}),
                json!({"Name": "Default", "Guid": "g0", "Custom Command": "No", "Command": ""}),
                json!({"Name": "py", "Guid": "g2", "Custom Command": "Yes", "Command": "python3"}),
                json!({"Name": "stale", "Guid": "g3", "Custom Command": "No", "Command": "ssh old.example.com"}),
            ],
            "profiles.json",
        );
        assert_eq!(p.source, "iterm2");
        assert_eq!(p.hosts.len(), 1);
        let web = &p.hosts[0];
        assert_eq!((web.name.as_str(), web.id.as_str(), web.hostname.as_str()), ("web", "g1", "10.0.0.4"));
        assert_eq!((web.port, web.user.as_deref()), (2222, Some("deploy")));
        assert_eq!(web.tags, vec!["prod".to_string(), "web".to_string()]);
    }

    #[test]
    fn non_ssh_profiles_skipped_silently() {
        let p = parse_profiles(&[json!({"Name": "zsh", "Custom Command": "No"})], "f");
        assert!(p.hosts.is_empty() && p.skipped.is_empty());
    }

    #[test]
    fn json_export_and_malformed() {
        let p = parse_json(r#"{"Profiles": [{"Name": "a", "Guid": "x", "Custom Command": "Yes", "Command": "ssh a.example.com"}]}"#, "f").unwrap();
        assert_eq!(p.hosts[0].hostname, "a.example.com");
        assert!(parse_json("{not json", "f").is_err());
        assert!(parse_json("[]", "f").unwrap().hosts.is_empty());
    }
}
