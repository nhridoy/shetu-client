//! Tabby SSH profiles from its `config.yaml`. Groups become folders; `jumpHost` links profiles.

use super::{ImportPreview, ImportedHost, Skipped};
use std::path::Path;

use yaml_rust2::{Yaml, YamlLoader};

/// Profile types Tabby ships for local use; not worth listing as skipped.
const BUILT_IN: [&str; 2] = ["local", "splash-tab"];

/// Tabby configs never use anchors and nest only a few levels. Refusing aliases stops "billion
/// laughs" copies; capping depth stops a deep `- - - …` file overflowing the stack while loading.
fn check_shape(text: &str) -> Result<(), String> {
    use yaml_rust2::parser::{Event, Parser};
    let mut parser = Parser::new_from_str(text);
    let mut depth = 0usize;
    loop {
        let (event, _) = parser.next_token().map_err(|e| format!("Couldn't read the Tabby config: {e}"))?;
        match event {
            Event::Alias(_) => return Err("This Tabby config uses YAML aliases, which aren't supported".into()),
            Event::SequenceStart(..) | Event::MappingStart(..) => {
                depth += 1;
                if depth > 64 {
                    return Err("This Tabby config is nested too deeply".into());
                }
            }
            Event::SequenceEnd | Event::MappingEnd => depth = depth.saturating_sub(1),
            Event::StreamEnd => return Ok(()),
            _ => {}
        }
    }
}

pub(crate) fn parse(text: &str, origin: &str) -> Result<ImportPreview, String> {
    check_shape(text)?;
    let docs = YamlLoader::load_from_str(text).map_err(|e| format!("Couldn't read the Tabby config: {e}"))?;
    let mut out = ImportPreview { source: "tabby".into(), origin: origin.into(), hosts: Vec::new(), skipped: Vec::new() };
    let Some(doc) = docs.first() else { return Ok(out) };
    let text_of = |y: &Yaml| match y {
        Yaml::String(s) => Some(s.trim().to_string()),
        Yaml::Integer(n) => Some(n.to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty());
    // Newer configs reference groups by id; older ones put the name on the profile.
    let groups: Vec<(String, String)> = doc["groups"]
        .as_vec()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((text_of(&g["id"])?, text_of(&g["name"])?)))
        .collect();
    for profile in doc["profiles"].as_vec().into_iter().flatten() {
        let name = text_of(&profile["name"]).unwrap_or_default();
        let kind = text_of(&profile["type"]).unwrap_or_default();
        if kind != "ssh" {
            if !BUILT_IN.contains(&kind.as_str()) {
                out.skipped.push(Skipped { name, reason: format!("{kind} profile") });
            }
            continue;
        }
        let options = &profile["options"];
        let Some(hostname) = text_of(&options["host"]) else {
            out.skipped.push(Skipped { name, reason: "No host name".into() });
            continue;
        };
        let group = text_of(&profile["group"]).map(|g| groups.iter().find(|(id, _)| *id == g).map_or(g.clone(), |(_, n)| n.clone()));
        let key = options["privateKeys"].as_vec().and_then(|keys| keys.first()).and_then(text_of).map(|k| {
            let path = k.strip_prefix("file://").unwrap_or(&k);
            super::encoding::percent_decode(path)
        });
        out.hosts.push(ImportedHost {
            id: text_of(&profile["id"]).unwrap_or_else(|| name.clone()),
            name,
            hostname,
            port: options["port"].as_i64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0).unwrap_or(22),
            user: text_of(&options["user"]),
            key: key.map(|k| super::describe_key(Path::new(&k))),
            jump: text_of(&options["jumpHost"]),
            folder: group.into_iter().collect(),
            tags: Vec::new(),
        });
    }
    Ok(out)
}

/// Tabby's own config on this device, if it has SSH profiles.
pub(crate) fn detected() -> Option<ImportPreview> {
    let path = dirs::config_dir()?.join("tabby").join("config.yaml");
    let text = super::read_source_file(&path).ok()?;
    let found = parse(&text, &path.to_string_lossy()).ok()?;
    (!found.hosts.is_empty() || !found.skipped.is_empty()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"version: 3
profiles:
  - type: ssh
    name: web
    id: ssh:custom:web:1111
    group: g-prod
    options:
      host: 10.0.0.4
      port: 2222
      user: deploy
      privateKeys:
        - file:///home/u/.ssh/id%20work
  - type: ssh
    name: inner
    id: ssh:custom:inner:2222
    group: Legacy
    options:
      host: 10.1.0.5
      jumpHost: ssh:custom:bastion:3333
  - type: ssh
    name: bastion
    id: ssh:custom:bastion:3333
    options: {host: b.example.com}
  - type: ssh
    name: lost
    id: ssh:custom:lost:4444
    options:
      host: l.example.com
      jumpHost: ssh:custom:gone:9999
  - type: serial
    name: console
    options: {port: /dev/ttyUSB0}
  - type: local
    name: zsh
groups:
  - id: g-prod
    name: Prod
"#;

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts.iter().find(|h| h.name == name).unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn ssh_profile_fields() {
        let p = parse(CONFIG, "config.yaml").unwrap();
        assert_eq!(p.source, "tabby");
        let web = host(&p, "web");
        assert_eq!((web.hostname.as_str(), web.port, web.user.as_deref()), ("10.0.0.4", 2222, Some("deploy")));
        assert_eq!(web.id, "ssh:custom:web:1111");
        assert_eq!(web.key.as_ref().unwrap().path, "/home/u/.ssh/id work");
        let b = host(&p, "bastion");
        assert_eq!((b.port, b.user.as_deref(), b.key.is_none()), (22, None, true));
    }

    #[test]
    fn group_by_id_or_name() {
        let p = parse(CONFIG, "f").unwrap();
        assert_eq!(host(&p, "web").folder, vec!["Prod".to_string()]);
        assert_eq!(host(&p, "inner").folder, vec!["Legacy".to_string()]);
        assert!(host(&p, "bastion").folder.is_empty());
    }

    #[test]
    fn jump_host_by_profile_id() {
        let p = parse(CONFIG, "f").unwrap();
        assert_eq!(host(&p, "inner").jump.as_deref(), Some("ssh:custom:bastion:3333"));
        // Unknown ids are kept; the shared planner notes them.
        assert_eq!(host(&p, "lost").jump.as_deref(), Some("ssh:custom:gone:9999"));
    }

    #[test]
    fn non_ssh_skipped() {
        let p = parse(CONFIG, "f").unwrap();
        assert!(p.skipped.contains(&Skipped { name: "console".into(), reason: "serial profile".into() }));
        assert!(p.skipped.iter().all(|s| s.name != "zsh"));
        assert_eq!(p.hosts.len(), 4);
    }

    #[test]
    fn anchor_bombs_and_deep_nesting_are_refused() {
        let bomb = "a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nprofiles: []\n";
        assert!(parse(bomb, "f").is_err());
        let deep = format!("{}x\n", "- ".repeat(20_000));
        assert!(parse(&deep, "f").is_err());
        // Ordinary nesting still loads.
        assert!(parse(CONFIG, "f").is_ok());
    }

    #[test]
    fn malformed_yaml_errors() {
        assert!(parse("profiles: [ {type: ssh", "f").is_err());
        assert!(parse("just: text", "f").unwrap().hosts.is_empty());
    }
}
