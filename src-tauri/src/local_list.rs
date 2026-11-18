//! Lists a local folder recursively with sizes and modified times (folder compare needs both;
//! the web-side local listing skips them).

use serde::Serialize;
use std::path::Path;

pub const TOO_MANY: &str = "Too many files to compare; pick a smaller folder";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds; 0 when unknown.
    pub mtime: i64,
}

pub fn list_recursive(root: &Path, cap: usize) -> Result<Vec<ListEntry>, String> {
    let mut entries = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for item in read {
            let item = item.map_err(|e| format!("{}: {e}", dir.display()))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            // DirEntry::metadata doesn't follow symlinks: a link is listed as a file, never walked.
            let meta = item.metadata();
            let meta = meta.map_err(|e| format!("{path}: {e}"))?;
            let is_dir = meta.file_type().is_dir();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            if is_dir {
                stack.push((item.path(), path.clone()));
            }
            entries.push(ListEntry {
                path,
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                mtime,
            });
            if entries.len() > cap {
                return Err(TOO_MANY.to_string());
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn local_list_recursive(path: String, cap: usize) -> Result<Vec<ListEntry>, String> {
    tokio::task::spawn_blocking(move || list_recursive(Path::new(&path), cap))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Dir {
            let p =
                std::env::temp_dir().join(format!("shetu-list-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    self.0.join("sub"),
                    std::fs::Permissions::from_mode(0o755),
                );
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_files_and_folders_with_sizes_and_times() {
        let d = Dir::new("ok");
        std::fs::write(d.0.join("a.txt"), b"abc").unwrap();
        std::fs::create_dir_all(d.0.join("sub")).unwrap();
        std::fs::write(d.0.join("sub/b.txt"), b"x").unwrap();
        std::fs::create_dir_all(d.0.join("empty")).unwrap();
        let mut entries = list_recursive(&d.0, 100).unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["a.txt", "empty", "sub", "sub/b.txt"]);
        let a = &entries[0];
        assert_eq!((a.is_dir, a.size), (false, 3));
        assert!(a.mtime > 1_600_000_000);
        assert!(entries[1].is_dir && entries[2].is_dir);
    }

    #[test]
    fn cap_is_an_error() {
        let d = Dir::new("cap");
        for i in 0..5 {
            std::fs::write(d.0.join(format!("{i}.txt")), b"x").unwrap();
        }
        assert_eq!(list_recursive(&d.0, 3), Err(TOO_MANY.to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subfolder_is_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let d = Dir::new("perm");
        std::fs::create_dir_all(d.0.join("sub")).unwrap();
        std::fs::write(d.0.join("sub/x"), b"x").unwrap();
        std::fs::set_permissions(d.0.join("sub"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let err = list_recursive(&d.0, 100).unwrap_err();
        assert!(err.contains("sub"), "{err}");
    }
}
