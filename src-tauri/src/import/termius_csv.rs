//! Termius-style host CSV (Termius has no export; this is its import layout), also Shetu's own export.

use super::{ImportPreview, ImportedHost, Skipped};

/// Header names each field may use (case-insensitive).
const NAME: &[&str] = &["label", "name", "alias", "title"];
const ADDRESS: &[&str] = &["hostname", "address", "ip", "host"];
const PORT: &[&str] = &["port"];
const USER: &[&str] = &["username", "user", "login"];
const GROUP: &[&str] = &["group", "folder"];
const TAGS: &[&str] = &["tags", "tag"];
const PROTOCOL: &[&str] = &["protocol"];

pub(crate) fn parse_csv(text: &str, origin: &str) -> Result<ImportPreview, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let headers: Vec<String> = reader
        .headers()
        .map_err(|e| format!("Couldn't read the CSV: {e}"))?
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    let column = |names: &[&str]| headers.iter().position(|h| names.contains(&h.as_str()));
    let address = column(ADDRESS).ok_or("The CSV has no address column")?;
    let (name, port, user, group, tags, protocol) = (
        column(NAME),
        column(PORT),
        column(USER),
        column(GROUP),
        column(TAGS),
        column(PROTOCOL),
    );
    let mut out = ImportPreview {
        source: "termius_csv".into(),
        origin: origin.into(),
        hosts: Vec::new(),
        skipped: Vec::new(),
    };
    for (n, record) in reader.records().enumerate() {
        let record = record.map_err(|e| format!("Couldn't read the CSV: {e}"))?;
        // Undo the export's formula guard ('=x → =x); other leading quotes stay.
        let field = |i: Option<usize>| {
            i.and_then(|i| record.get(i))
                .map(str::trim)
                .map(|v| match v.strip_prefix('\'') {
                    Some(rest) if rest.starts_with(crate::export::FORMULA_START) => rest,
                    _ => v,
                })
                .filter(|v| !v.is_empty())
        };
        let hostname = field(Some(address));
        let label = field(name).or(hostname).unwrap_or("").to_string();
        if record.iter().all(|v| v.trim().is_empty()) {
            continue;
        }
        if let Some(p) = field(protocol)
            .map(str::to_ascii_lowercase)
            .filter(|p| p != "ssh")
        {
            out.skipped.push(Skipped {
                name: label,
                reason: format!("{p} row"),
            });
            continue;
        }
        let Some(hostname) = hostname else {
            out.skipped.push(Skipped {
                name: label,
                reason: "No address".into(),
            });
            continue;
        };
        let split = |v: Option<&str>, seps: &[char]| -> Vec<String> {
            v.map(|v| {
                v.split(seps)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
        };
        out.hosts.push(ImportedHost {
            id: format!("row{}", n + 1),
            name: label,
            hostname: hostname.to_string(),
            port: field(port).and_then(|p| p.parse().ok()).unwrap_or(22),
            user: field(user).map(String::from),
            key: None,
            jump: None,
            folder: split(field(group), &['/']),
            tags: split(field(tags), &[',', ';']),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host<'a>(p: &'a ImportPreview, name: &str) -> &'a ImportedHost {
        p.hosts
            .iter()
            .find(|h| h.name == name)
            .unwrap_or_else(|| panic!("{name} in {p:?}"))
    }

    #[test]
    fn termius_csv_aliases_and_groups() {
        let p = parse_csv(
            "Label,IP,Port,Username,Group,Tags\nweb,10.0.0.4,2222,deploy,Prod/Web,a;b\ndb,10.0.0.9,,,Prod,\"a, b\"\n,10.0.0.7,,,,\n",
            "hosts.csv",
        )
        .unwrap();
        assert_eq!(p.source, "termius_csv");
        let web = host(&p, "web");
        assert_eq!(
            (web.hostname.as_str(), web.port, web.user.as_deref()),
            ("10.0.0.4", 2222, Some("deploy"))
        );
        assert_eq!(web.folder, vec!["Prod".to_string(), "Web".to_string()]);
        assert_eq!(web.tags, vec!["a".to_string(), "b".to_string()]);
        let db = host(&p, "db");
        assert_eq!((db.port, db.user.as_deref()), (22, None));
        assert_eq!(db.tags, vec!["a".to_string(), "b".to_string()]);
        // A row without a label is named after its address.
        assert_eq!(host(&p, "10.0.0.7").hostname, "10.0.0.7");
    }

    #[test]
    fn termius_csv_bom_quotes_blank_lines() {
        let p = parse_csv(
            "\u{FEFF}name,hostname\n\n\"web, primary\",w.example.com\n\n",
            "f",
        )
        .unwrap();
        assert_eq!(host(&p, "web, primary").hostname, "w.example.com");
        assert_eq!(p.hosts.len(), 1);
    }

    #[test]
    fn termius_csv_protocol_filter() {
        let p = parse_csv(
            "label,address,protocol\na,1.1.1.1,ssh\nb,2.2.2.2,telnet\nc,3.3.3.3,\nd,,ssh\n",
            "f",
        )
        .unwrap();
        let names: Vec<_> = p.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["a", "c"]);
        assert!(p.skipped.contains(&Skipped {
            name: "b".into(),
            reason: "telnet row".into()
        }));
        assert!(p.skipped.contains(&Skipped {
            name: "d".into(),
            reason: "No address".into()
        }));
    }

    #[test]
    fn termius_csv_requires_address_column() {
        assert_eq!(
            parse_csv("label,port\na,22\n", "f").unwrap_err(),
            "The CSV has no address column"
        );
    }
}
