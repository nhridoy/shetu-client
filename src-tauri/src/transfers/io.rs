//! Reading and writing one side of a transfer: `.part` files, resume offsets, the final rename.

use super::model::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub enum Side {
    Local,
    Sftp(Arc<russh_sftp::client::SftpSession>),
}

const CHUNK: usize = 64 * 1024;

fn io_err(op: &str, e: std::io::Error) -> JobError {
    match classify_io(&e) {
        ErrorClass::Operation => JobError::Operation(format!("{op}: {e}")),
        ErrorClass::Connection => JobError::Connection(format!("{op}: {e}")),
    }
}

fn sftp_err(op: &str, e: russh_sftp::client::error::Error) -> JobError {
    match classify_sftp(&e) {
        ErrorClass::Operation => JobError::Operation(format!("{op}: {e}")),
        ErrorClass::Connection => JobError::Connection(format!("{op}: {e}")),
    }
}

fn is_sftp_not_found(e: &russh_sftp::client::error::Error) -> bool {
    matches!(e, russh_sftp::client::error::Error::Status(s)
        if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile)
}

/// (size, mtime in seconds)
pub async fn stat(side: &Side, path: &str) -> Result<(u64, i64), JobError> {
    match side {
        Side::Local => {
            let m = tokio::fs::metadata(path)
                .await
                .map_err(|e| io_err("stat", e))?;
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            Ok((m.len(), mtime))
        }
        Side::Sftp(s) => {
            let m = s.metadata(path).await.map_err(|e| sftp_err("stat", e))?;
            Ok((m.len(), m.mtime.map_or(0, i64::from)))
        }
    }
}

pub async fn part_len(side: &Side, part: &str) -> Result<Option<u64>, JobError> {
    match side {
        Side::Local => match tokio::fs::metadata(part).await {
            Ok(m) => Ok(Some(m.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err("stat part", e)),
        },
        Side::Sftp(s) => match s.metadata(part).await {
            Ok(m) => Ok(Some(m.len())),
            Err(e) if is_sftp_not_found(&e) => Ok(None),
            Err(e) => Err(sftp_err("stat part", e)),
        },
    }
}

async fn exists(side: &Side, path: &str) -> Result<bool, JobError> {
    match side {
        Side::Local => tokio::fs::try_exists(path)
            .await
            .map_err(|e| io_err("stat", e)),
        Side::Sftp(s) => s.try_exists(path).await.map_err(|e| sftp_err("stat", e)),
    }
}

enum Writer {
    Local(tokio::fs::File),
    Sftp(russh_sftp::client::fs::File),
}

impl Writer {
    async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        match self {
            Writer::Local(f) => f.write_all(buf).await,
            Writer::Sftp(f) => f.write_all(buf).await,
        }
    }

    async fn close(self) -> Result<(), JobError> {
        use tokio::io::AsyncWriteExt;
        match self {
            Writer::Local(mut f) => {
                f.flush().await.map_err(|e| io_err("write", e))?;
                f.sync_all().await.map_err(|e| io_err("fsync", e))
            }
            Writer::Sftp(mut f) => {
                f.flush().await.map_err(|e| io_err("write", e))?;
                f.sync_all().await.map_err(|e| sftp_err("fsync", e))?;
                f.shutdown().await.map_err(|e| io_err("close", e))
            }
        }
    }
}

async fn open_source(
    side: &Side,
    path: &str,
    offset: u64,
) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, JobError> {
    use std::io::SeekFrom;
    use tokio::io::AsyncSeekExt;
    match side {
        Side::Local => {
            let mut f = tokio::fs::File::open(path)
                .await
                .map_err(|e| io_err("open", e))?;
            if offset > 0 {
                f.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| io_err("seek", e))?;
            }
            Ok(Box::new(f))
        }
        Side::Sftp(s) => {
            let mut f = s.open(path).await.map_err(|e| sftp_err("open", e))?;
            if offset > 0 {
                f.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| io_err("seek", e))?;
            }
            Ok(Box::new(f))
        }
    }
}

/// Opens the `.part` file: truncated when starting from zero, otherwise positioned at `offset`.
async fn open_part(side: &Side, part: &str, offset: u64) -> Result<Writer, JobError> {
    use russh_sftp::protocol::OpenFlags;
    use std::io::SeekFrom;
    use tokio::io::AsyncSeekExt;
    match side {
        Side::Local => {
            let mut f = tokio::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(offset == 0)
                .open(part)
                .await
                .map_err(|e| io_err("create part", e))?;
            if offset > 0 {
                f.set_len(offset)
                    .await
                    .map_err(|e| io_err("truncate part", e))?;
                f.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| io_err("seek part", e))?;
            }
            Ok(Writer::Local(f))
        }
        Side::Sftp(s) => {
            let mut flags = OpenFlags::WRITE | OpenFlags::CREATE;
            if offset == 0 {
                flags |= OpenFlags::TRUNCATE;
            }
            let mut f = s
                .open_with_flags(part, flags)
                .await
                .map_err(|e| sftp_err("create part", e))?;
            if offset > 0 {
                f.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| io_err("seek part", e))?;
            }
            Ok(Writer::Sftp(f))
        }
    }
}

/// Copies `src_path` into `part` from `offset`. Every read and write races `stop`, so a pause
/// or cancel takes effect even when the connection hangs. `progress` gets the bytes in `part`.
pub async fn copy(
    src: &Side,
    src_path: &str,
    dst: &Side,
    part: &str,
    offset: u64,
    stop: &CancellationToken,
    mut progress: impl FnMut(u64),
) -> Result<(), JobError> {
    use tokio::io::AsyncReadExt;
    let mut reader = open_source(src, src_path, offset).await?;
    let mut writer = open_part(dst, part, offset).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut written = offset;
    loop {
        let n = tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(JobError::Stopped),
            r = reader.read(&mut buf) => r.map_err(|e| io_err("read", e))?,
        };
        if n == 0 {
            break;
        }
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(JobError::Stopped),
            r = writer.write_all(&buf[..n]) => r.map_err(|e| io_err("write", e))?,
        }
        written += n as u64;
        progress(written);
    }
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err(JobError::Stopped),
        r = writer.close() => r,
    }
}

/// Moves the finished `.part` into place and returns where it landed. Without an approved
/// replace, a destination that appeared meanwhile keeps its file and this one gets a free name.
pub async fn finish(dst: &Side, part: &str, dest: &str, replace: bool) -> Result<String, JobError> {
    if !replace && matches!(dst, Side::Local) {
        return publish_local_new(part, dest).await;
    }
    let mut target = dest.to_string();
    if !replace {
        let mut tried = std::collections::HashSet::new();
        while exists(dst, &target).await? {
            tried.insert(target.clone());
            target = free_name(dest, |p| tried.contains(p));
        }
    }
    match dst {
        // std's rename replaces an existing file on every platform.
        Side::Local => tokio::fs::rename(part, &target)
            .await
            .map_err(|e| io_err("rename", e))?,
        Side::Sftp(s) => {
            // shortcut: plain SFTP rename refuses an existing target, so remove it first; a
            // posix-rename would be atomic but russh-sftp 2.4 doesn't expose extensions.
            if replace && exists(dst, &target).await? {
                s.remove_file(target.as_str())
                    .await
                    .map_err(|e| sftp_err("replace", e))?;
            }
            s.rename(part, target.as_str())
                .await
                .map_err(|e| sftp_err("rename", e))?;
        }
    }
    Ok(target)
}

/// Publishes without ever replacing. A hard link fails atomically if the name is taken (even by
/// a file that appeared a moment ago), and then the next free name is tried. Filesystems
/// without hard links (FAT) reserve the name with an exclusive create and move onto that.
async fn publish_local_new(part: &str, dest: &str) -> Result<String, JobError> {
    let mut tried = std::collections::HashSet::new();
    let mut target = dest.to_string();
    let mut links = true;
    let mut placeholder: PlaceholderId = None;
    loop {
        let claimed = if links {
            tokio::fs::hard_link(part, &target).await
        } else {
            let created = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .await;
            match created {
                Ok(file) => {
                    placeholder = file.metadata().await.ok().and_then(|m| placeholder_id(&m));
                    Ok(())
                }
                Err(e) => Err(e),
            }
        };
        match claimed {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                tried.insert(target.clone());
                target = free_name(dest, |p| tried.contains(p));
            }
            Err(e) if links && links_unsupported(&e) => links = false,
            Err(e) => return Err(io_err("publish", e)),
        }
    }
    if links {
        // The data is in place under `target`; a leftover `.part` is only clutter.
        let _ = tokio::fs::remove_file(part).await;
        return Ok(target);
    }
    // shortcut: between the exclusive create and this rename another process could swap our
    // empty placeholder; std has no no-replace rename for FAT. Upgrade with renameat2 /
    // MoveFileEx if that ever matters.
    if let Err(e) = tokio::fs::rename(part, &target).await {
        remove_placeholder(&target, placeholder).await;
        return Err(io_err("rename", e));
    }
    Ok(target)
}

/// Identity of a placeholder we created (device + inode), to recognise it again. `None` where
/// std can't tell (Windows); cleanup then relies on the empty-file check alone.
type PlaceholderId = Option<(u64, u64)>;

fn placeholder_id(m: &std::fs::Metadata) -> PlaceholderId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        None
    }
}

/// Whether a hard-link failure means "this filesystem can't hard-link" (then the placeholder
/// path is used) rather than a real error that must fail the publish.
fn links_unsupported(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    // vfat on Linux answers EPERM; Windows FAT answers ERROR_INVALID_FUNCTION (1) or
    // ERROR_NOT_SUPPORTED (50).
    matches!(
        e.kind(),
        ErrorKind::Unsupported | ErrorKind::PermissionDenied
    ) || (cfg!(windows) && matches!(e.raw_os_error(), Some(1 | 50)))
}

/// Removes a publish placeholder only while it is still ours and empty.
async fn remove_placeholder(path: &str, ours: PlaceholderId) {
    let Ok(now) = tokio::fs::metadata(path).await else {
        return;
    };
    let same = ours.is_none_or(|id| placeholder_id(&now) == Some(id));
    if same && now.is_file() && now.len() == 0 {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// Deletes a `.part` that must not survive (a stale resume). Already missing is fine; any
/// other failure is returned.
pub async fn discard_part(side: &Side, part: &str) -> Result<(), JobError> {
    match side {
        Side::Local => match tokio::fs::remove_file(part).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err("remove part", e)),
            _ => Ok(()),
        },
        Side::Sftp(s) => match s.remove_file(part).await {
            Err(e) if !is_sftp_not_found(&e) => Err(sftp_err("remove part", e)),
            _ => Ok(()),
        },
    }
}

/// Best effort: a missing file or a dropped connection is ignored.
pub async fn remove_part(side: &Side, part: &str) {
    match side {
        Side::Local => {
            let _ = tokio::fs::remove_file(part).await;
        }
        Side::Sftp(s) => {
            let _ = s.remove_file(part).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Dir {
            let p = std::env::temp_dir().join(format!("shetu-io-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
        fn path(&self, f: &str) -> String {
            self.0.join(f).display().to_string()
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn source(d: &Dir) -> (String, Vec<u8>) {
        let data: Vec<u8> = (0..100u8).collect();
        let p = d.path("src.bin");
        std::fs::write(&p, &data).unwrap();
        (p, data)
    }

    #[tokio::test]
    async fn copy_from_zero_then_finish_renames() {
        let d = Dir::new("zero");
        let (src, data) = source(&d);
        let (part, dest) = (d.path("out.bin.1234abcd.part"), d.path("out.bin"));
        let mut seen = Vec::new();
        copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            0,
            &CancellationToken::new(),
            |n| seen.push(n),
        )
        .await
        .unwrap();
        assert_eq!(seen.last(), Some(&100));
        assert_eq!(
            finish(&Side::Local, &part, &dest, false).await.unwrap(),
            dest
        );
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(!std::path::Path::new(&part).exists());
    }

    #[tokio::test]
    async fn copy_resumes_by_appending_from_offset() {
        let d = Dir::new("resume");
        let (src, data) = source(&d);
        let (part, dest) = (d.path("out.part"), d.path("out.bin"));
        std::fs::write(&part, &data[..40]).unwrap();
        assert_eq!(part_len(&Side::Local, &part).await.unwrap(), Some(40));
        let mut first = None;
        copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            40,
            &CancellationToken::new(),
            |n| {
                first.get_or_insert(n);
            },
        )
        .await
        .unwrap();
        assert!(first.unwrap() > 40, "progress counts the resumed bytes too");
        finish(&Side::Local, &part, &dest, false).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn copy_offset_zero_truncates_existing_part() {
        let d = Dir::new("trunc");
        let (src, data) = source(&d);
        let part = d.path("out.part");
        std::fs::write(&part, vec![9u8; 500]).unwrap();
        copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            0,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
    }

    #[tokio::test]
    async fn stopped_copy_returns_stopped_and_keeps_part() {
        let d = Dir::new("stop");
        let (src, _) = source(&d);
        let part = d.path("out.part");
        let stop = CancellationToken::new();
        stop.cancel();
        let r = copy(&Side::Local, &src, &Side::Local, &part, 0, &stop, |_| {}).await;
        assert_eq!(r, Err(JobError::Stopped));
        assert!(std::path::Path::new(&part).exists());
    }

    #[tokio::test]
    async fn finish_new_with_existing_dest_uses_free_name() {
        let d = Dir::new("free");
        let (part, dest) = (d.path("a.txt.x.part"), d.path("a.txt"));
        std::fs::write(&dest, b"mine").unwrap();
        std::fs::write(&part, b"new").unwrap();
        let landed = finish(&Side::Local, &part, &dest, false).await.unwrap();
        assert_eq!(landed, d.path("a (copy).txt"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"mine");
        assert_eq!(std::fs::read(&landed).unwrap(), b"new");
    }

    #[tokio::test]
    async fn finish_replace_overwrites_dest() {
        let d = Dir::new("replace");
        let (part, dest) = (d.path("a.txt.x.part"), d.path("a.txt"));
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&part, b"new").unwrap();
        assert_eq!(
            finish(&Side::Local, &part, &dest, true).await.unwrap(),
            dest
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[tokio::test]
    async fn copy_missing_source_is_operation_error() {
        let d = Dir::new("missing");
        let r = copy(
            &Side::Local,
            &d.path("nope"),
            &Side::Local,
            &d.path("o.part"),
            0,
            &CancellationToken::new(),
            |_| {},
        )
        .await;
        assert!(
            matches!(r, Err(JobError::Operation(ref m)) if m.starts_with("open")),
            "got {r:?}"
        );
        assert!(matches!(
            stat(&Side::Local, &d.path("nope")).await,
            Err(JobError::Operation(_))
        ));
    }

    #[tokio::test]
    async fn stat_reports_size_and_mtime() {
        let d = Dir::new("stat");
        let (src, _) = source(&d);
        let (size, mtime) = stat(&Side::Local, &src).await.unwrap();
        assert_eq!(size, 100);
        assert!(mtime > 1_600_000_000);
        assert_eq!(part_len(&Side::Local, &d.path("none")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn discard_part_reports_failures_but_not_missing() {
        let d = Dir::new("discard");
        assert_eq!(
            discard_part(&Side::Local, &d.path("none.part")).await,
            Ok(())
        );
        let part = d.path("o.part");
        std::fs::write(&part, b"x").unwrap();
        assert_eq!(discard_part(&Side::Local, &part).await, Ok(()));
        assert!(!std::path::Path::new(&part).exists());
        // Something that can't be removed as a file.
        let stuck = d.path("stuck.part");
        std::fs::create_dir_all(format!("{stuck}/inside")).unwrap();
        assert!(discard_part(&Side::Local, &stuck).await.is_err());
        assert!(std::path::Path::new(&stuck).exists());
    }

    #[tokio::test]
    async fn failed_publish_leaves_no_placeholder() {
        let d = Dir::new("noplace");
        let dest = d.path("a.txt");
        // The part is missing, so the move can't happen: the reserved name must not linger.
        let r = finish(&Side::Local, &d.path("missing.part"), &dest, false).await;
        assert!(r.is_err());
        assert!(!std::path::Path::new(&dest).exists());
    }

    #[tokio::test]
    async fn publish_new_reserves_the_name_before_moving() {
        let d = Dir::new("reserve");
        let (part, dest) = (d.path("a.txt.x.part"), d.path("a.txt"));
        std::fs::write(&part, b"new").unwrap();
        assert_eq!(
            finish(&Side::Local, &part, &dest, false).await.unwrap(),
            dest
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!std::path::Path::new(&part).exists());
    }

    #[tokio::test]
    async fn placeholder_cleanup_spares_a_file_that_took_its_place() {
        let d = Dir::new("spare");
        let ours = d.path("ours.txt");
        std::fs::write(&ours, b"").unwrap();
        let id = placeholder_id(&std::fs::metadata(&ours).unwrap());
        remove_placeholder(&ours, id).await;
        assert!(
            !std::path::Path::new(&ours).exists(),
            "our empty placeholder goes"
        );

        let theirs = d.path("theirs.txt");
        std::fs::write(&theirs, b"").unwrap();
        let id = placeholder_id(&std::fs::metadata(&theirs).unwrap());
        std::fs::write(&theirs, b"someone else's data").unwrap();
        remove_placeholder(&theirs, id).await;
        assert_eq!(std::fs::read(&theirs).unwrap(), b"someone else's data");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn placeholder_cleanup_spares_an_empty_file_swapped_in() {
        let d = Dir::new("swap");
        let path = d.path("a.txt");
        std::fs::write(&path, b"").unwrap();
        let ours = placeholder_id(&std::fs::metadata(&path).unwrap());
        // Another process swaps in its own (also empty) file.
        let other = d.path("other");
        std::fs::write(&other, b"").unwrap();
        std::fs::rename(&other, &path).unwrap();
        remove_placeholder(&path, ours).await;
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn only_missing_link_support_falls_back() {
        use std::io::{Error, ErrorKind};
        assert!(links_unsupported(&Error::from(ErrorKind::Unsupported)));
        assert!(links_unsupported(&Error::from(ErrorKind::PermissionDenied)));
        assert!(!links_unsupported(&Error::from(ErrorKind::StorageFull)));
        assert!(!links_unsupported(&Error::other("I/O error")));
    }

    #[tokio::test]
    async fn remove_part_deletes_file() {
        let d = Dir::new("rm");
        let part = d.path("o.part");
        std::fs::write(&part, b"x").unwrap();
        remove_part(&Side::Local, &part).await;
        assert!(!std::path::Path::new(&part).exists());
        remove_part(&Side::Local, &part).await; // already gone: no panic
    }
}
