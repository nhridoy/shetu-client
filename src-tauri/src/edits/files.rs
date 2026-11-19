//! The edits' temp folders and their saved list (`edits.json`).

use super::state::Edit;
use std::path::{Path, PathBuf};

pub const LIST_FILE: &str = "edits.json";

/// Creates `<root>/<id>/`, readable only by this user.
pub fn create_edit_dir(root: &Path, id: &str) -> std::io::Result<PathBuf> {
    let dir = root.join(id);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir)?;
    Ok(dir)
}

/// Writes the list atomically (temp file, then rename), readable only by this user: the root
/// may be the shared temp folder.
pub fn save_edits(root: &Path, edits: &[Edit]) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(edits).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("{LIST_FILE}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(&tmp).map_err(|e| e.to_string())?, &json)
        .map_err(|e| e.to_string())?;
    // Never replace a list that can't be read: its folders may hold unsent work.
    let list = root.join(LIST_FILE);
    if list.exists() && load_edits(root).is_err() {
        set_aside(root).map_err(|e| format!("keeping the unreadable list: {e}"))?;
    }
    std::fs::rename(&tmp, list).map_err(|e| e.to_string())
}

fn set_aside(root: &Path) -> std::io::Result<()> {
    let aside = root.join(format!(
        "{UNREADABLE}-{}",
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::rename(root.join(LIST_FILE), aside)
}

/// Deletes every temp copy (sign-out); already gone is fine, anything else is reported.
pub fn remove_root(root: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(root) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("Couldn't delete the remote-edit copies: {e}"))
        }
        _ => Ok(()),
    }
}

const UNREADABLE: &str = "edits.json.unreadable";

/// The saved list at startup, and whether stale folders may be deleted. An unreadable list is
/// moved aside and kept; while it exists nothing is deleted, since its folders may hold unsent
/// work no list names any more.
pub fn load_for_startup(root: &Path) -> (Vec<Edit>, bool) {
    let loaded = load_edits(root);
    if let Err(e) = &loaded {
        log::warn!("edits: could not read the saved list: {e}");
        let _ = set_aside(root);
    }
    let quarantined = std::fs::read_dir(root).is_ok_and(|dirs| {
        dirs.flatten()
            .any(|d| d.file_name().to_string_lossy().starts_with(UNREADABLE))
    });
    let may_sweep = loaded.is_ok() && !quarantined;
    (loaded.unwrap_or_default(), may_sweep)
}

/// The temp copy's file name: the remote one, with characters Windows (or a path) would read
/// specially replaced, so it always lands inside its edit folder.
pub fn local_file_name(remote_path: &str) -> String {
    let name = remote_path.rsplit('/').next().unwrap_or_default();
    let safe: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Windows drops trailing dots and spaces, and reserves device names even with an extension.
    let safe = safe.trim_end_matches(['.', ' ']);
    let stem = safe
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if safe.is_empty() {
        "file".into()
    } else if device {
        format!("_{safe}")
    } else {
        safe.to_string()
    }
}

/// The saved list; none saved yet is an empty list.
pub fn load_edits(root: &Path) -> Result<Vec<Edit>, String> {
    match std::fs::read(root.join(LIST_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// `dir` is one of our edit folders: directly inside `root` (no `..` tricks).
pub fn inside_root(root: &Path, dir: &Path) -> bool {
    use std::path::Component;
    dir.parent() == Some(root) && matches!(dir.components().next_back(), Some(Component::Normal(_)))
}

/// Folders to delete at startup: those not kept. When the saved list couldn't be read
/// (`keep` is None), nothing is deleted: unsent work may be in there.
pub fn sweep_targets(root: &Path, keep: Option<&[String]>) -> Vec<PathBuf> {
    let Some(keep) = keep else { return Vec::new() };
    let Ok(dirs) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = dirs
        .flatten()
        .filter(|d| d.path().is_dir())
        .filter(|d| {
            !keep
                .iter()
                .any(|k| d.file_name().to_string_lossy() == k.as_str())
        })
        .map(|d| d.path())
        .collect();
    out.sort();
    out
}

/// Where to watch an edit: its folder and file name.
pub fn watch_target(edit: &Edit) -> Option<(PathBuf, String)> {
    let local = Path::new(&edit.local_path);
    Some((
        local.parent()?.to_path_buf(),
        local.file_name()?.to_string_lossy().into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edits::state::EditStatus;
    use crate::transfers::model::HostRef;

    fn root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("shetu-edits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn edit() -> Edit {
        Edit {
            id: "e".into(),
            session_id: "pane-1".into(),
            host: HostRef {
                host_id: Some("h1".into()),
                host: "web-01".into(),
                port: 22,
                username: "me".into(),
            },
            remote_path: "/etc/nginx.conf".into(),
            local_path: "/tmp/x/e/nginx.conf".into(),
            baseline: (10, 100),
            last_local: (12, 200),
            unsent: true,
            status: EditStatus::Conflict,
            job: None,
            uploading: None,
            dirty: false,
            saving_copy: false,
            conflict: Some((99, 300)),
            error: None,
        }
    }

    #[test]
    fn edits_json_roundtrip_and_missing_file_is_empty() {
        let r = root();
        assert_eq!(load_edits(&r).unwrap(), Vec::<Edit>::new());
        save_edits(&r, &[edit()]).unwrap();
        assert_eq!(load_edits(&r).unwrap(), vec![edit()]);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn inside_root_rejects_escapes() {
        let r = Path::new("/cache/remote-edits");
        assert!(inside_root(r, Path::new("/cache/remote-edits/abc")));
        assert!(!inside_root(
            r,
            Path::new("/cache/remote-edits/../../home/me")
        ));
        assert!(!inside_root(r, Path::new("/cache/remote-edits")));
        assert!(!inside_root(r, Path::new("/cache/remote-edits/a/b")));
        assert!(!inside_root(r, Path::new("/elsewhere/abc")));
    }

    #[test]
    fn unreadable_list_sweeps_nothing() {
        let r = root();
        std::fs::create_dir_all(r.join("kept")).unwrap();
        std::fs::create_dir_all(r.join("stale")).unwrap();
        assert!(sweep_targets(&r, None).is_empty());
        let keep = vec!["kept".to_string()];
        assert_eq!(sweep_targets(&r, Some(&keep)), vec![r.join("stale")]);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn watch_target_is_the_folder_and_file_name() {
        assert_eq!(
            watch_target(&edit()),
            Some((PathBuf::from("/tmp/x/e"), "nginx.conf".to_string()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn saved_list_and_its_folder_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let r = root();
        std::fs::set_permissions(&r, std::fs::Permissions::from_mode(0o755)).unwrap();
        save_edits(&r, &[edit()]).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&r), 0o700);
        assert_eq!(mode(&r.join(LIST_FILE)), 0o600);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn local_names_are_safe_on_every_platform() {
        assert_eq!(local_file_name("/srv/nginx.conf"), "nginx.conf");
        assert_eq!(local_file_name("/srv/..\\..\\evil"), ".._.._evil");
        assert_eq!(local_file_name("/srv/a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(local_file_name("/srv/.."), "file");
        assert_eq!(local_file_name("/"), "file");
    }

    #[test]
    fn windows_device_names_become_ordinary_names() {
        assert_eq!(local_file_name("/srv/CON.txt"), "_CON.txt");
        assert_eq!(local_file_name("/srv/nul"), "_nul");
        assert_eq!(local_file_name("/srv/com1.log"), "_com1.log");
        assert_eq!(local_file_name("/srv/notes. "), "notes");
        assert_eq!(local_file_name("/srv/console.txt"), "console.txt");
    }

    #[test]
    fn saving_never_replaces_an_unreadable_list() {
        let r = root();
        std::fs::write(r.join(LIST_FILE), b"{not json").unwrap();
        save_edits(&r, &[]).unwrap();
        assert!(!load_for_startup(&r).1, "the old list is kept aside");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[cfg(unix)]
    #[test]
    fn removing_the_root_reports_failure() {
        use std::os::unix::fs::PermissionsExt;
        let r = root();
        assert!(remove_root(&r.join("missing")).is_ok());
        let edits = r.join("remote-edits");
        std::fs::create_dir_all(edits.join("e1")).unwrap();
        std::fs::set_permissions(&edits, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(remove_root(&edits).is_err());
        std::fs::set_permissions(&edits, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(remove_root(&edits).is_ok());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn an_unreadable_list_is_kept_and_blocks_cleanup_until_looked_at() {
        let r = root();
        std::fs::write(r.join(LIST_FILE), b"{not json").unwrap();
        let (edits, may_sweep) = load_for_startup(&r);
        assert!(edits.is_empty());
        assert!(!may_sweep);
        // Later saves don't make the old folders deletable.
        save_edits(&r, &[]).unwrap();
        assert!(!load_for_startup(&r).1);
        let kept = std::fs::read_dir(&r).unwrap().flatten().any(|d| {
            d.file_name()
                .to_string_lossy()
                .starts_with("edits.json.unreadable")
        });
        assert!(kept, "the unreadable list is kept for recovery");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn a_readable_list_allows_cleanup() {
        let r = root();
        save_edits(&r, &[edit()]).unwrap();
        assert_eq!(load_for_startup(&r), (vec![edit()], true));
        let _ = std::fs::remove_dir_all(&r);
    }

    #[cfg(unix)]
    #[test]
    fn temp_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let r = root();
        let dir = create_edit_dir(&r, "e1").unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&r);
    }
}
