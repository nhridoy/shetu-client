/// `[section]` headers with `key=value` lines, in file order. `;`/`#` lines are comments.
pub(crate) fn sections(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with([';', '#']) {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push((name.to_string(), Vec::new()));
        } else if let (Some((key, value)), Some(section)) = (line.split_once('='), out.last_mut()) {
            section
                .1
                .push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sections_in_order() {
        let s = sections("; c\r\n[a]\r\nk = v\r\n\r\n[b\\c]\nx=1=2\n#n\n");
        assert_eq!(
            s,
            vec![
                ("a".to_string(), vec![("k".to_string(), "v".to_string())]),
                (
                    "b\\c".to_string(),
                    vec![("x".to_string(), "1=2".to_string())]
                ),
            ]
        );
    }
}
