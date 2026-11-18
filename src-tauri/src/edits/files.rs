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

/// Writes the list atomically (temp file, then rename).
pub fn save_edits(root: &Path, edits: &[Edit]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(edits).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("{LIST_FILE}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, root.join(LIST_FILE)).map_err(|e| e.to_string())
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
    fn temp_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let r = root();
        let dir = create_edit_dir(&r, "e1").unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&r);
    }
}
