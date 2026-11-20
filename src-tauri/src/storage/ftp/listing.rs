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

fn is_self_or_parent(f: &File) -> bool {
    matches!(f.name(), "." | "..")
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
                .map(|f| f.keys().any(|k| k.eq_ignore_ascii_case("MLSD")))
                .unwrap_or(false);
            *core.mlsd.get_or_init(|| has)
        }
    };
    let files: Vec<File> = if mlsd {
        conn.mlsd(target.as_deref())
            .await
            .map_err(format_ftp_error)?
            .iter()
            .filter_map(|l| suppaftp::list::ListParser::parse_mlsd(&mlsx_line(l)).ok())
            .collect()
    } else {
        let with_a = match &target {
            Some(t) => format!("-a {t}"),
            None => "-a".to_string(),
        };
        match conn.list(Some(&with_a)).await {
            Ok(lines) => lines,
            Err(_) => {
                // A failed data command can leave its reply unread: use a fresh connection.
                drop(conn);
                conn = core.ftp_connect(Operation::List).await?;
                conn.list(target.as_deref())
                    .await
                    .map_err(format_ftp_error)?
            }
        }
        .iter()
        .filter_map(|l| File::from_str(l).ok())
        .collect()
    };
    let mut out = Vec::with_capacity(files.len());
    for f in files.iter().filter(|f| !is_self_or_parent(f)) {
        let (dir, size) = if f.is_symlink() {
            let full = match &target {
                Some(t) => format!("{t}/{}", f.name()),
                None => f.name().to_string(),
            };
            match conn.size(&full).await {
                Ok(n) => (false, n as u64),
                Err(_) => (true, 0),
            }
        } else {
            (f.is_directory(), f.size() as u64)
        };
        out.push(Entry {
            name: f.name().to_string(),
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
