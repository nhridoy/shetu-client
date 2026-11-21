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

/// Normalises MLSD facts for suppaftp's parser: `type=OS.unix=slink:/target` has a second `=`,
/// and `modify=…` / `create=…` may carry a fraction of a second (RFC 3659), which it rejects.
fn mlsx_line(line: &str) -> String {
    line.split(';')
        .map(|fact| {
            let lower = fact.to_ascii_lowercase();
            if lower.starts_with("type=os.unix=slink") || lower.starts_with("type=os.unix=symlink")
            {
                "type=link".to_string()
            } else if lower.starts_with("modify=") || lower.starts_with("create=") {
                fact.split('.').next().unwrap_or(fact).to_string()
            } else {
                fact.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// An MLSD line split into its pathname, which may itself contain `;` or spaces (suppaftp would
/// take only what follows the last `;`), and its parsed facts if they parse.
fn mlsd_entry(line: &str) -> Option<(String, Option<File>)> {
    let (facts, name) = line.split_once(' ')?;
    let file = suppaftp::list::ListParser::parse_mlsd(&format!("{} x", mlsx_line(facts))).ok();
    Some((name.to_string(), file))
}

/// One folder's listing.
struct Listing {
    entries: Vec<Entry>,
    /// Every name the server sent, including lines whose details didn't parse.
    names: Vec<String>,
    /// MLSD or `LIST -a`; a plain `LIST` may leave out dot-files.
    shows_hidden: bool,
    /// Every line was understood, so a name that isn't in `names` really is absent.
    complete: bool,
}

/// `path` is OpenDAL's: `/` for the root, else `dir/` relative to it.
pub async fn list_dir(core: &FtpCore, path: &str) -> Result<Vec<Entry>> {
    list_dir_with(core, path).await.map(|l| l.entries)
}

async fn list_dir_with(core: &FtpCore, path: &str) -> Result<Listing> {
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
    let mut shows_hidden = true;
    let mut complete = true;
    let mut names = Vec::new();
    let mut files: Vec<(String, File)> = Vec::new();
    if mlsd {
        for line in conn
            .mlsd(target.as_deref())
            .await
            .map_err(format_ftp_error)?
        {
            match mlsd_entry(&line) {
                Some((name, file)) => {
                    names.push(name.clone());
                    match file {
                        Some(file) => files.push((name, file)),
                        None => complete = false,
                    }
                }
                None => complete = false,
            }
        }
    } else {
        let with_a = match &target {
            Some(t) => format!("-a {t}"),
            None => "-a".to_string(),
        };
        let lines = match conn.list(Some(&with_a)).await {
            Ok(lines) => lines,
            Err(_) => {
                shows_hidden = false;
                // A failed data command can leave its reply unread: never reuse that connection.
                drop(conn.detach());
                conn = core.ftp_connect(Operation::List).await?;
                conn.list(target.as_deref())
                    .await
                    .map_err(format_ftp_error)?
            }
        };
        for line in lines.iter().filter(|l| !l.starts_with("total ")) {
            match File::from_str(line) {
                Ok(file) => {
                    names.push(file.name().to_string());
                    files.push((file.name().to_string(), file));
                }
                Err(_) => complete = false,
            }
        }
    }
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
    Ok(Listing {
        entries: out,
        names,
        shows_hidden,
        complete,
    })
}

/// What a folder listing says about one name.
enum Presence {
    Found(Entry),
    /// Listed, but its details didn't parse.
    Listed,
    Absent,
}

/// An error when the listing can't tell (refused, lines it couldn't read, hidden names it may
/// omit): never "absent" by default.
async fn presence(core: &FtpCore, path: &str) -> Result<Presence> {
    let name = get_basename(path).trim_end_matches('/');
    // A refused listing (550, which also reads as "not found") proves nothing.
    let unknown = |e: Error| {
        Error::new(ErrorKind::Unexpected, "couldn't check whether it exists").set_source(e)
    };
    let listing = list_dir_with(core, get_parent(path))
        .await
        .map_err(unknown)?;
    if let Some(entry) = listing.entries.into_iter().find(|e| e.name == name) {
        return Ok(Presence::Found(entry));
    }
    if listing.names.iter().any(|n| n == name) {
        return Ok(Presence::Listed);
    }
    if !listing.complete || (name.starts_with('.') && !listing.shows_hidden) {
        return Err(Error::new(
            ErrorKind::Unexpected,
            "couldn't check whether it exists: the server's listing may leave it out",
        ));
    }
    Ok(Presence::Absent)
}

/// `path`'s entry, or `None` when it's surely absent; an error when the type can't be told.
pub async fn lookup(core: &FtpCore, path: &str) -> Result<Option<Entry>> {
    match presence(core, path).await? {
        Presence::Found(entry) => Ok(Some(entry)),
        Presence::Absent => Ok(None),
        Presence::Listed => Err(Error::new(
            ErrorKind::Unexpected,
            "couldn't read the server's details for it",
        )),
    }
}

/// Whether `path` is in its folder's listing. An error means "can't tell", never "no".
pub async fn exists(core: &FtpCore, path: &str) -> Result<bool> {
    Ok(!matches!(presence(core, path).await?, Presence::Absent))
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
        assert_eq!(
            super::mlsx_line("type=file;modify=20240102030405.123; a"),
            "type=file;modify=20240102030405; a"
        );
    }
}
