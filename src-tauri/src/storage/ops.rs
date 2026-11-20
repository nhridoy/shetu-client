//! Bucket operations over an OpenDAL operator, with UI paths (`/a/b.txt`) in and out.

use opendal::{Metadata, Operator};
use serde::Serialize;

/// The largest object one S3 copy request can copy (5 GiB).
pub const COPY_LIMIT: u64 = 5 * 1024 * 1024 * 1024;
/// The user-metadata key holding the source file's own time, in seconds.
pub const MTIME_KEY: &str = "mtime";

/// One listed object or folder, as the file browser shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub name: String,
    /// `/`-rooted, no trailing slash.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
}

/// A UI path as a bucket key: no leading `/`; folders end in `/`; the root is `""`.
pub fn to_key(ui_path: &str, dir: bool) -> String {
    let key = ui_path.trim_matches('/');
    if key.is_empty() {
        String::new()
    } else if dir {
        format!("{key}/")
    } else {
        key.to_string()
    }
}

/// A listing's entry for the listed folder itself (`""`, `/` or `dir/`, by service).
fn is_itself(key: &str, dir: &str) -> bool {
    key.trim_matches('/') == dir.trim_matches('/')
}

fn to_ui(key: &str) -> String {
    format!("/{}", key.trim_end_matches('/'))
}

fn err(op: &str, e: opendal::Error) -> String {
    format!("{op}: {e}")
}

/// The object's own time if Shetu saved one, else when the bucket last changed it.
pub fn mtime_of(meta: &Metadata) -> i64 {
    let saved = meta
        .user_metadata()
        .and_then(|m| m.get(MTIME_KEY))
        .and_then(|v| v.parse::<i64>().ok());
    saved.unwrap_or_else(|| {
        meta.last_modified()
            .map(std::time::SystemTime::from)
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64)
    })
}

fn entry(key: &str, meta: &Metadata) -> StorageEntry {
    let path = to_ui(key);
    StorageEntry {
        name: path.rsplit('/').next().unwrap_or_default().to_string(),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() {
            0
        } else {
            meta.content_length()
        },
        mtime: mtime_of(meta),
        path,
    }
}

/// One folder level; folder markers and shared prefixes both show as folders.
pub async fn list_dir(op: &Operator, ui_path: &str) -> Result<Vec<StorageEntry>, String> {
    let dir = to_key(ui_path, true);
    let mut out: Vec<StorageEntry> = op
        .list(&dir)
        .await
        .map_err(|e| err("list", e))?
        .iter()
        .filter(|e| !is_itself(e.path(), &dir))
        .map(|e| entry(e.path(), e.metadata()))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Every object under a folder (for compare and folder rename), refusing past `cap`.
pub async fn list_tree(
    op: &Operator,
    ui_path: &str,
    cap: usize,
) -> Result<Vec<StorageEntry>, String> {
    let dir = to_key(ui_path, true);
    let entries = op
        .list_with(&dir)
        .recursive(true)
        .await
        .map_err(|e| err("list", e))?;
    let out: Vec<StorageEntry> = entries
        .iter()
        .filter(|e| !is_itself(e.path(), &dir))
        .map(|e| entry(e.path(), e.metadata()))
        .collect();
    if out.len() > cap {
        return Err(crate::local_list::TOO_MANY.to_string());
    }
    Ok(out)
}

/// Lists one entry, to check the bucket can be reached and read. One request, however large
/// the bucket.
pub async fn check_access(op: &Operator) -> Result<(), String> {
    check_access_raw(op)
        .await
        .map_err(|e| format!("Couldn't reach the bucket: {e}"))
}

/// `check_access` keeping OpenDAL's error, so a certificate failure can be told apart.
pub async fn check_access_raw(op: &Operator) -> Result<(), opendal::Error> {
    use futures::TryStreamExt;
    op.lister_with("/")
        .limit(1)
        .await?
        .try_next()
        .await
        .map(|_| ())
}

/// `(size, mtime)` of an object, `None` when it doesn't exist.
pub async fn stat(op: &Operator, ui_path: &str) -> Result<Option<(u64, i64)>, String> {
    match op.stat(&to_key(ui_path, false)).await {
        Ok(meta) => Ok(Some((meta.content_length(), mtime_of(&meta)))),
        Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err("stat", e)),
    }
}

/// An empty `name/` marker object, which buckets show as a folder.
pub async fn mkdir(op: &Operator, ui_path: &str) -> Result<(), String> {
    op.create_dir(&to_key(ui_path, true))
        .await
        .map_err(|e| err("new folder", e))
}

/// Deletes an object, or a folder and everything under it.
pub async fn delete(op: &Operator, ui_path: &str, is_dir: bool) -> Result<(), String> {
    if is_dir {
        op.delete_with(&to_key(ui_path, true))
            .recursive(true)
            .await
            .map_err(|e| err("delete", e))
    } else {
        op.delete(&to_key(ui_path, false))
            .await
            .map_err(|e| err("delete", e))
    }
}

/// Renames an object, or a folder object by object: each is copied, then the original is
/// deleted, so nothing is lost if it stops partway.
pub async fn rename_tree(op: &Operator, from: &str, to: &str, is_dir: bool) -> Result<(), String> {
    rename_tree_inner(op, from, to, is_dir, COPY_LIMIT, None).await
}

/// `limit` is the largest copyable object; `fail_after` (tests only) fails the copy after
/// that many objects.
pub(crate) async fn rename_tree_inner(
    op: &Operator,
    from: &str,
    to: &str,
    is_dir: bool,
    limit: u64,
    fail_after: Option<usize>,
) -> Result<(), String> {
    let objects: Vec<(String, u64, bool)> = if is_dir {
        list_tree(op, from, usize::MAX)
            .await?
            .into_iter()
            .map(|e| (to_key(&e.path, e.is_dir), e.size, e.is_dir))
            .collect()
    } else {
        let size = stat(op, from)
            .await?
            .ok_or_else(|| format!("{from} no longer exists"))?
            .0;
        vec![(to_key(from, false), size, false)]
    };
    // S3 copy replaces whatever is there: never rename onto an existing object or folder.
    let taken = if is_dir {
        !list_dir(op, to).await?.is_empty()
    } else {
        stat(op, to).await?.is_some()
    };
    if taken {
        return Err(format!("{to} already exists. Nothing was moved."));
    }
    // A server that can move (WebDAV) renames a file in one request: no copy, no size limit.
    // (OpenDAL renames files only; a WebDAV folder moves through `webdav::move_dir`.)
    if !is_dir && op.info().capability().rename {
        return op
            .rename(&to_key(from, false), &to_key(to, false))
            .await
            .map_err(|e| err("rename", e));
    }
    if let Some((key, _, _)) = objects.iter().find(|(_, size, _)| *size > limit) {
        return Err(format!(
            "{} is too large to rename in the bucket (over 5 GiB). Nothing was moved.",
            to_ui(key)
        ));
    }
    let (from_prefix, to_prefix) = if is_dir {
        (to_key(from, true), to_key(to, true))
    } else {
        (to_key(from, false), to_key(to, false))
    };
    let total = objects.len();
    for (moved, (key, _, dir)) in objects.iter().enumerate() {
        let target = format!("{to_prefix}{}", &key[from_prefix.len()..]);
        let step = async {
            if fail_after.is_some_and(|n| moved >= n) {
                return Err("copy failed".to_string());
            }
            if *dir {
                op.create_dir(&target).await.map_err(|e| err("copy", e))?;
            } else {
                op.copy(key, &target).await.map_err(|e| err("copy", e))?;
            }
            op.delete(key).await.map_err(|e| err("delete", e))
        };
        if let Err(e) = step.await {
            return Err(format!(
                "Moved {moved} of {total} objects; the rest are still under {from}. {e}"
            ));
        }
    }
    // The folder itself: a marker under the new name (so an emptied folder still shows), and
    // the old marker gone.
    if is_dir {
        op.create_dir(&to_prefix)
            .await
            .map_err(|e| err("new folder", e))?;
        op.delete(&from_prefix)
            .await
            .map_err(|e| err("delete", e))?;
    }
    Ok(())
}

/// Reads a whole object, refusing ones over `max` bytes.
pub async fn read_small(op: &Operator, ui_path: &str, max: u64) -> Result<Vec<u8>, String> {
    let key = to_key(ui_path, false);
    let size = op
        .stat(&key)
        .await
        .map_err(|e| err("read", e))?
        .content_length();
    if size > max {
        return Err(format!("{ui_path} is too large to open here"));
    }
    Ok(op.read(&key).await.map_err(|e| err("read", e))?.to_vec())
}

pub async fn write_small(op: &Operator, ui_path: &str, data: Vec<u8>) -> Result<(), String> {
    op.write(&to_key(ui_path, false), data)
        .await
        .map(|_| ())
        .map_err(|e| err("write", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Operator {
        Operator::new(opendal::services::Memory::default()).unwrap()
    }

    /// For copies: the memory service can't copy (S3 can), a temp folder can.
    fn folder() -> Operator {
        let dir = std::env::temp_dir().join(format!("shetu-ops-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Operator::new(opendal::services::Fs::default().root(&dir.display().to_string())).unwrap()
    }

    async fn put(op: &Operator, key: &str, body: &str) {
        op.write(key, body.as_bytes().to_vec()).await.unwrap();
    }

    fn names(list: &[StorageEntry]) -> Vec<(String, bool)> {
        list.iter().map(|e| (e.name.clone(), e.is_dir)).collect()
    }

    #[test]
    fn to_key_normalises_ui_paths() {
        assert_eq!(to_key("/", true), "");
        assert_eq!(to_key("", true), "");
        assert_eq!(to_key("/a/b.txt", false), "a/b.txt");
        assert_eq!(to_key("/a/b", true), "a/b/");
        assert_eq!(to_key("/a/b/", true), "a/b/");
        assert_eq!(to_key("a b/ü#+.txt", false), "a b/ü#+.txt");
    }

    #[tokio::test]
    async fn list_dir_shows_markers_and_prefixes_as_folders() {
        let op = memory();
        op.create_dir("a/").await.unwrap();
        put(&op, "b/x.txt", "x").await;
        put(&op, "c.txt", "hello").await;
        let root = list_dir(&op, "/").await.unwrap();
        assert_eq!(
            names(&root),
            vec![
                ("a".to_string(), true),
                ("b".to_string(), true),
                ("c.txt".to_string(), false)
            ]
        );
        let c = root.iter().find(|e| e.name == "c.txt").unwrap();
        assert_eq!((c.path.as_str(), c.size), ("/c.txt", 5));
        assert_eq!(root[0].path, "/a");
        assert!(list_dir(&op, "/a").await.unwrap().is_empty());
        assert_eq!(
            names(&list_dir(&op, "/b").await.unwrap()),
            vec![("x.txt".into(), false)]
        );
    }

    #[tokio::test]
    async fn ops_round_trip_odd_names() {
        let op = folder();
        mkdir(&op, "/a b").await.unwrap();
        write_small(&op, "/a b/ü#+.txt", b"data".to_vec())
            .await
            .unwrap();
        assert_eq!(
            stat(&op, "/a b/ü#+.txt").await.unwrap().map(|s| s.0),
            Some(4)
        );
        rename_tree(&op, "/a b/ü#+.txt", "/a b/ok.txt", false)
            .await
            .unwrap();
        assert_eq!(stat(&op, "/a b/ü#+.txt").await.unwrap(), None);
        assert_eq!(read_small(&op, "/a b/ok.txt", 100).await.unwrap(), b"data");
        delete(&op, "/a b", true).await.unwrap();
        assert!(list_dir(&op, "/").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stat_prefers_the_saved_mtime() {
        let op = memory();
        put(&op, "plain.txt", "x").await;
        assert!(stat(&op, "/plain.txt").await.unwrap().is_some());
        assert_eq!(stat(&op, "/none.txt").await.unwrap(), None);
    }

    #[tokio::test]
    async fn rename_tree_moves_everything_then_deletes() {
        let op = folder();
        op.create_dir("f/").await.unwrap();
        put(&op, "f/one.txt", "1").await;
        put(&op, "f/sub/two.txt", "22").await;
        rename_tree(&op, "/f", "/g", true).await.unwrap();
        assert_eq!(read_small(&op, "/g/one.txt", 10).await.unwrap(), b"1");
        assert_eq!(read_small(&op, "/g/sub/two.txt", 10).await.unwrap(), b"22");
        assert_eq!(
            names(&list_dir(&op, "/").await.unwrap()),
            vec![("g".into(), true)]
        );
    }

    #[tokio::test]
    async fn rename_tree_refuses_over_copy_limit_before_moving() {
        let op = memory();
        put(&op, "f/small.txt", "1").await;
        put(&op, "f/big.bin", "1234").await;
        let err = rename_tree_inner(&op, "/f", "/g", true, 3, None)
            .await
            .unwrap_err();
        assert!(
            err.contains("big.bin") && err.contains("too large"),
            "{err}"
        );
        assert_eq!(read_small(&op, "/f/small.txt", 10).await.unwrap(), b"1");
        assert_eq!(stat(&op, "/g/small.txt").await.unwrap(), None);
    }

    #[tokio::test]
    async fn rename_tree_reports_partial_progress() {
        let op = folder();
        put(&op, "f/a.txt", "a").await;
        put(&op, "f/b.txt", "b").await;
        let err = rename_tree_inner(&op, "/f", "/g", true, COPY_LIMIT, Some(1))
            .await
            .unwrap_err();
        assert!(err.contains("Moved 1 of 2"), "{err}");
        let left = list_tree(&op, "/f", 10).await.unwrap();
        assert_eq!(left.len(), 1, "the unmoved object stays under the old name");
    }

    #[tokio::test]
    async fn list_tree_errs_over_cap() {
        let op = memory();
        for i in 0..4 {
            put(&op, &format!("d/{i}.txt"), "x").await;
        }
        assert_eq!(list_tree(&op, "/d", 4).await.unwrap().len(), 4);
        assert_eq!(
            list_tree(&op, "/d", 3).await.unwrap_err(),
            crate::local_list::TOO_MANY
        );
    }

    #[tokio::test]
    async fn rename_refuses_an_existing_name() {
        let op = folder();
        put(&op, "a.txt", "A").await;
        put(&op, "b.txt", "B").await;
        let err = rename_tree(&op, "/a.txt", "/b.txt", false)
            .await
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(read_small(&op, "/a.txt", 10).await.unwrap(), b"A");
        assert_eq!(read_small(&op, "/b.txt", 10).await.unwrap(), b"B");
        put(&op, "f/x.txt", "x").await;
        put(&op, "g/y.txt", "y").await;
        let err = rename_tree(&op, "/f", "/g", true).await.unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(read_small(&op, "/f/x.txt", 10).await.unwrap(), b"x");
    }

    #[tokio::test]
    async fn check_access_reads_one_entry() {
        let op = memory();
        assert!(check_access(&op).await.is_ok());
        for i in 0..5 {
            put(&op, &format!("{i}.txt"), "x").await;
        }
        assert!(check_access(&op).await.is_ok());
    }

    #[tokio::test]
    async fn rename_uses_native_move_when_supported() {
        let op = folder();
        assert!(op.info().capability().rename);
        put(&op, "a.txt", "a").await;
        rename_tree(&op, "/a.txt", "/b.txt", false).await.unwrap();
        assert_eq!(read_small(&op, "/b.txt", 10).await.unwrap(), b"a");
        assert_eq!(stat(&op, "/a.txt").await.unwrap(), None);
        put(&op, "c.txt", "c").await;
        let err = rename_tree(&op, "/b.txt", "/c.txt", false)
            .await
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }
}
