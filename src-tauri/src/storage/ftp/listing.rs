// Shetu: directory listings for the FTP service (not from upstream; see CHANGES.md).
//
// Upstream listed with a plain `LIST`, which many servers answer without dot-files, and gave
// symlinks no type. This lists with `MLSD` when the server advertises it, else `LIST -a`, else
// `LIST`, and resolves each symlink once (`SIZE` answers for a file; anything else is a folder).

use std::str::FromStr;
use std::time::SystemTime;

use suppaftp::list::File;

use super::core::{format_ftp_error, FtpCore};
use opendal::raw::*;
use opendal::*;

/// One listed entry, symlinks already resolved.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub modified: SystemTime,
}

/// MLSD's `type=OS.unix=slink:/target` has a second `=` that suppaftp's parser can't take.
fn mlsx_line(line: &str) -> String {
    line.split(';')
        .map(|fact| {
            let lower = fact.to_ascii_lowercase();
            if lower.starts_with("type=os.unix=slink") || lower.starts_with("type=os.unix=symlink")
            {
                "type=link"
            } else {
                fact
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// An MLSD line: facts, a space, then the pathname, which may itself contain `;` or spaces
/// (suppaftp would take only what follows the last `;`).
fn mlsd_entry(line: &str) -> Option<(String, File)> {
    let (facts, name) = line.split_once(' ')?;
    let file = suppaftp::list::ListParser::parse_mlsd(&format!("{} x", mlsx_line(facts))).ok()?;
    Some((name.to_string(), file))
}

/// `path` is OpenDAL's: `/` for the root, else `dir/` relative to it.
pub async fn list_dir(core: &FtpCore, path: &str) -> Result<Vec<Entry>> {
    let target = (path != "/").then(|| path.trim_end_matches('/').to_string());
    let mut conn = core.ftp_connect(Operation::List).await?;
    let mlsd = match core.mlsd.get() {
        Some(known) => *known,
        None => {
            let has = conn
                .feat()
                .await
                // RFC 3659: the MLST feature line advertises MLSD too.
                .map(|f| {
                    f.keys()
                        .any(|k| k.eq_ignore_ascii_case("MLST") || k.eq_ignore_ascii_case("MLSD"))
                })
                .unwrap_or(false);
            *core.mlsd.get_or_init(|| has)
        }
    };
    let files: Vec<(String, File)> = if mlsd {
        conn.mlsd(target.as_deref())
            .await
            .map_err(format_ftp_error)?
            .iter()
            .filter_map(|l| mlsd_entry(l))
            .collect()
    } else {
        let with_a = match &target {
            Some(t) => format!("-a {t}"),
            None => "-a".to_string(),
        };
        match conn.list(Some(&with_a)).await {
            Ok(lines) => lines,
            Err(_) => {
                // A failed data command can leave its reply unread: never reuse that connection.
                drop(conn.detach());
                conn = core.ftp_connect(Operation::List).await?;
                conn.list(target.as_deref())
                    .await
                    .map_err(format_ftp_error)?
            }
        }
        .iter()
        .filter_map(|l| File::from_str(l).ok())
        .map(|f| (f.name().to_string(), f))
        .collect()
    };
    let mut out = Vec::with_capacity(files.len());
    for (name, f) in files
        .iter()
        .filter(|(n, _)| !matches!(n.as_str(), "." | ".."))
    {
        let (dir, size) = if f.is_symlink() {
            let full = match &target {
                Some(t) => format!("{t}/{name}"),
                None => name.clone(),
            };
            match conn.size(&full).await {
                Ok(n) => (false, n as u64),
                // The server answered: not a plain file (or no SIZE), so treat it as a folder.
                Err(suppaftp::FtpError::UnexpectedResponse(_)) => (true, 0),
                Err(e) => return Err(format_ftp_error(e)),
            }
        } else {
            (f.is_directory(), f.size() as u64)
        };
        out.push(Entry {
            name: name.clone(),
            dir,
            size,
            modified: f.modified(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn mlsd_symlink_facts_become_links() {
        assert_eq!(
            super::mlsx_line("type=OS.unix=slink:/public_html;modify=20240102030405; www"),
            "type=link;modify=20240102030405; www"
        );
        assert_eq!(
            super::mlsx_line("type=file;size=3; a"),
            "type=file;size=3; a"
        );
    }
}
