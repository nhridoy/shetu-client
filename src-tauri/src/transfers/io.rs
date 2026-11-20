//! Reading and writing one side of a transfer: `.part` files, resume offsets, the final rename.

use super::model::*;
use crate::storage::Remote;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub enum Side {
    Local,
    Sftp(Arc<russh_sftp::client::SftpSession>),
    /// A bucket. Paths are UI paths (`/a/b.txt`); an upload writes the final key directly.
    Remote(Remote),
}

const CHUNK: usize = 64 * 1024;
/// Part size for bucket uploads. Fixed, so every part but the last is exactly this long
/// (R2 requires it).
const REMOTE_PART: usize = 8 * 1024 * 1024;

impl Side {
    /// A storage side with no WebDAV upload target (S3, tests).
    pub fn remote(op: opendal::Operator) -> Side {
        Side::Remote(Remote { op, dav: None })
    }
}

/// How an upload to a bucket is written. Ignored for other destinations.
#[derive(Debug, Clone, Copy, Default)]
pub struct WriteOpts {
    /// Saved as the object's `mtime` metadata (the source's own time), when non-zero.
    pub mtime: i64,
    /// Refuse to write over an existing key (`DEST_CHANGED`), where the service supports it.
    pub if_not_exists: bool,
}

fn key(path: &str) -> String {
    crate::storage::ops::to_key(path, false)
}

/// Bucket errors by what a retry can fix: the request itself (missing, refused, invalid) is
/// an operation error; anything else (network, rate limits, server trouble) is retried.
pub fn opendal_err(op: &str, e: opendal::Error) -> JobError {
    use opendal::ErrorKind::*;
    // A server whose certificate isn't trusted won't become trusted by retrying.
    if crate::storage::tls::is_cert_error(&e) {
        return JobError::Operation(crate::storage::tls::CERT_UNTRUSTED.into());
    }
    match e.kind() {
        ConditionNotMatch => JobError::Operation(DEST_CHANGED.into()),
        NotFound | PermissionDenied | ConfigInvalid | IsADirectory | NotADirectory
        | Unsupported => JobError::Operation(format!("{op}: {e}")),
        _ => JobError::Connection(format!("{op}: {e}")),
    }
}

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
        Side::Remote(Remote { op, .. }) => {
            let m = op
                .stat(&key(path))
                .await
                .map_err(|e| opendal_err("stat", e))?;
            Ok((m.content_length(), crate::storage::ops::mtime_of(&m)))
        }
    }
}

/// Like `stat`, but a missing file is `None`; any other failure (e.g. permission denied) is
/// an error, never taken for absence.
pub async fn stat_if_exists(side: &Side, path: &str) -> Result<Option<(u64, i64)>, JobError> {
    let missing = match side {
        Side::Local => match tokio::fs::metadata(path).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(io_err("stat", e)),
            Ok(_) => false,
        },
        Side::Sftp(s) => match s.metadata(path).await {
            Err(e) if is_sftp_not_found(&e) => true,
            Err(e) => return Err(sftp_err("stat", e)),
            Ok(_) => false,
        },
        Side::Remote(Remote { op, .. }) => match op.stat(&key(path)).await {
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => true,
            Err(e) => return Err(opendal_err("stat", e)),
            Ok(_) => false,
        },
    };
    if missing {
        return Ok(None);
    }
    stat(side, path).await.map(Some)
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
        // An upload to a bucket never keeps a partial object: it always starts over.
        Side::Remote(_) => Ok(None),
    }
}

async fn exists(side: &Side, path: &str) -> Result<bool, JobError> {
    match side {
        Side::Local => tokio::fs::try_exists(path)
            .await
            .map_err(|e| io_err("stat", e)),
        Side::Sftp(s) => s.try_exists(path).await.map_err(|e| sftp_err("stat", e)),
        Side::Remote(Remote { op, .. }) => op
            .exists(&key(path))
            .await
            .map_err(|e| opendal_err("stat", e)),
    }
}

enum Writer {
    Local(tokio::fs::File),
    Sftp(russh_sftp::client::fs::File),
    Remote(RemoteWriter),
}

#[cfg(test)]
pub(crate) static REMOTE_ABORTS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// A bucket upload. Pause and cancel drop the run mid-copy, and an OpenDAL writer dropped
/// without `close`/`abort` leaves its multipart parts billed, so dropping one unfinished
/// aborts it in the background.
struct RemoteWriter(Option<opendal::Writer>);

impl RemoteWriter {
    /// The writer stays owned until the abort finishes: if this is dropped mid-abort (a pause
    /// during a slow abort), `Drop` still aborts it.
    async fn abort(&mut self) {
        if let Some(w) = self.0.as_mut() {
            #[cfg(test)]
            REMOTE_ABORTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Err(e) = w.abort().await {
                log::warn!("transfers: couldn't abort a bucket upload: {e}");
            }
        }
        self.0 = None;
    }
}

impl Drop for RemoteWriter {
    fn drop(&mut self) {
        if let Some(mut w) = self.0.take() {
            #[cfg(test)]
            REMOTE_ABORTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    if let Err(e) = w.abort().await {
                        log::warn!("transfers: couldn't abort a bucket upload: {e}");
                    }
                });
            }
        }
    }
}

impl Writer {
    async fn write_all(&mut self, buf: &[u8]) -> Result<(), JobError> {
        use tokio::io::AsyncWriteExt;
        match self {
            Writer::Local(f) => f.write_all(buf).await.map_err(|e| io_err("write", e)),
            Writer::Sftp(f) => f.write_all(buf).await.map_err(|e| io_err("write", e)),
            Writer::Remote(RemoteWriter(Some(w))) => w
                .write(buf.to_vec())
                .await
                .map_err(|e| opendal_err("write", e)),
            Writer::Remote(RemoteWriter(None)) => Err(JobError::Stopped),
        }
    }

    async fn close(&mut self) -> Result<(), JobError> {
        use tokio::io::AsyncWriteExt;
        match self {
            Writer::Local(f) => {
                f.flush().await.map_err(|e| io_err("write", e))?;
                f.sync_all().await.map_err(|e| io_err("fsync", e))
            }
            Writer::Sftp(f) => {
                f.flush().await.map_err(|e| io_err("write", e))?;
                f.sync_all().await.map_err(|e| sftp_err("fsync", e))?;
                f.shutdown().await.map_err(|e| io_err("close", e))
            }
            Writer::Remote(r) => {
                let Some(w) = r.0.as_mut() else {
                    return Err(JobError::Stopped);
                };
                w.close().await.map_err(|e| opendal_err("write", e))?;
                // Complete: nothing to abort when dropped.
                r.0 = None;
                Ok(())
            }
        }
    }

    /// A bucket upload that won't finish is aborted, so its parts don't stay billed. Best
    /// effort; files need nothing (the `.part` stays for a resume).
    async fn abort(&mut self) {
        if let Writer::Remote(r) = self {
            r.abort().await;
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
        Side::Remote(Remote { op, .. }) => {
            use tokio_util::compat::FuturesAsyncReadCompatExt;
            let reader = op
                .reader_with(&key(path))
                .await
                .map_err(|e| opendal_err("open", e))?
                .into_futures_async_read(offset..)
                .await
                .map_err(|e| opendal_err("open", e))?;
            Ok(Box::new(reader.compat()))
        }
    }
}

/// Opens the `.part` file: truncated when starting from zero, otherwise positioned at `offset`.
/// For a bucket, `part` is the final key and the object appears only once it is complete.
async fn open_part(
    side: &Side,
    part: &str,
    offset: u64,
    opts: WriteOpts,
) -> Result<Writer, JobError> {
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
        Side::Remote(Remote { op, dav }) => {
            let can = op.info().capability();
            let path = key(part);
            let mut w = op.writer_with(&path).chunk(REMOTE_PART);
            // WebDAV would send metadata as a separate PROPPATCH that some servers refuse.
            if opts.mtime > 0 && can.write_with_user_metadata && dav.is_none() {
                w = w.user_metadata([(
                    crate::storage::ops::MTIME_KEY.to_string(),
                    opts.mtime.to_string(),
                )]);
            }
            if opts.if_not_exists && can.write_with_if_not_exists {
                w = w.if_not_exists(true);
            }
            Ok(Writer::Remote(RemoteWriter(Some(
                w.await.map_err(|e| opendal_err("create", e))?,
            ))))
        }
    }
}

/// Copies `src_path` into `part` from `offset`. Every read and write races `stop`, so a pause
/// or cancel takes effect even when the connection hangs. `progress` gets the bytes in `part`.
#[allow(clippy::too_many_arguments)]
pub async fn copy(
    src: &Side,
    src_path: &str,
    dst: &Side,
    part: &str,
    offset: u64,
    stop: &CancellationToken,
    opts: WriteOpts,
    mut progress: impl FnMut(u64),
) -> Result<(), JobError> {
    use tokio::io::AsyncReadExt;
    let mut reader = open_source(src, src_path, offset).await?;
    let mut writer = open_part(dst, part, offset, opts).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut written = offset;
    let result = async {
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
                r = writer.write_all(&buf[..n]) => r?,
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
    .await;
    if result.is_err() {
        writer.abort().await;
    }
    result
}

/// Moves the finished `.part` into place and returns where it landed. Without an approved
/// replace, a destination that appeared meanwhile keeps its file and this one gets a free name.
pub async fn finish(
    dst: &Side,
    part: &str,
    dest: &str,
    replace: bool,
    mtime: i64,
) -> Result<String, JobError> {
    // A bucket upload already wrote its final key (see `remote_target`).
    if matches!(dst, Side::Remote(_)) {
        return Ok(part.to_string());
    }
    // The `.part` gets the source's time before it is published; the rename keeps it.
    if mtime > 0 {
        set_mtime(dst, part, mtime).await;
    }
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
        // Returned above: a bucket upload is already in place.
        Side::Remote(_) => {}
    }
    Ok(target)
}

/// Sets a file's modified (and accessed) time to `mtime` seconds. Best effort: some servers
/// refuse `setstat`; the copy is still good, so this only logs.
pub(crate) async fn set_mtime(side: &Side, path: &str, mtime: i64) {
    match side {
        Side::Local => {
            let path = path.to_string();
            let result = tokio::task::spawn_blocking(move || {
                let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                let times = std::fs::FileTimes::new().set_modified(at).set_accessed(at);
                std::fs::File::options()
                    .write(true)
                    .open(&path)?
                    .set_times(times)
            })
            .await;
            if let Ok(Err(e)) = result {
                log::warn!("transfers: could not keep the modified time: {e}");
            }
        }
        Side::Sftp(s) => {
            let attrs = russh_sftp::protocol::FileAttributes {
                mtime: Some(mtime as u32),
                atime: Some(mtime as u32),
                ..russh_sftp::protocol::FileAttributes::empty()
            };
            if let Err(e) = s.set_metadata(path, attrs).await {
                log::warn!("transfers: could not keep the modified time: {e}");
            }
        }
        // A bucket sets its own time; the source's travels in the `mtime` metadata.
        Side::Remote(_) => {}
    }
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
        // No partial objects in a bucket (an unfinished upload is aborted).
        Side::Remote(_) => Ok(()),
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
        Side::Remote(_) => {}
    }
}

/// Where an upload to a bucket writes: `dest` when replacing, otherwise the first free name
/// (the same naming as files get).
pub async fn remote_target(dst: &Side, dest: &str, replace: bool) -> Result<String, JobError> {
    if replace {
        return Ok(dest.to_string());
    }
    let mut target = dest.to_string();
    let mut tried = std::collections::HashSet::new();
    while exists(dst, &target).await? {
        tried.insert(target.clone());
        target = free_name(dest, |p| tried.contains(p));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn bucket() -> opendal::Operator {
        opendal::Operator::new(opendal::services::Memory::default()).unwrap()
    }

    #[tokio::test]
    async fn remote_stat_and_missing() {
        let op = bucket();
        op.write("a/b.txt", b"hello".to_vec()).await.unwrap();
        let side = Side::remote(op);
        assert_eq!(stat_if_exists(&side, "/none").await.unwrap(), None);
        assert_eq!(
            stat_if_exists(&side, "/a/b.txt")
                .await
                .unwrap()
                .map(|s| s.0),
            Some(5)
        );
        assert!(matches!(
            stat(&side, "/none").await,
            Err(JobError::Operation(_))
        ));
        assert_eq!(part_len(&side, "/a/b.txt").await.unwrap(), None);
    }

    #[tokio::test]
    async fn download_from_remote_resumes_from_offset() {
        let d = Dir::new("rdl");
        let op = bucket();
        op.write("obj", b"0123456789".to_vec()).await.unwrap();
        let part = d.path("obj.part");
        std::fs::write(&part, b"012").unwrap();
        copy(
            &Side::remote(op),
            "/obj",
            &Side::Local,
            &part,
            3,
            &CancellationToken::new(),
            WriteOpts::default(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"0123456789");
    }

    #[tokio::test]
    async fn upload_to_remote_writes_the_key_directly() {
        let d = Dir::new("rup");
        let src = d.path("src.txt");
        std::fs::write(&src, b"payload").unwrap();
        let op = bucket();
        let side = Side::remote(op.clone());
        copy(
            &Side::Local,
            &src,
            &side,
            "/up/a.txt",
            0,
            &CancellationToken::new(),
            WriteOpts {
                mtime: 1_700_000_000,
                if_not_exists: false,
            },
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(op.read("up/a.txt").await.unwrap().to_vec(), b"payload");
        let keys = op.list_with("").recursive(true).await.unwrap();
        assert!(
            keys.iter().all(|e| !e.path().ends_with(".part")),
            "no .part object"
        );
    }

    #[tokio::test]
    async fn stopped_upload_leaves_no_object() {
        let d = Dir::new("rstop");
        let src = d.path("src.txt");
        std::fs::write(&src, vec![b'x'; 300_000]).unwrap();
        let op = bucket();
        let stop = CancellationToken::new();
        stop.cancel();
        let r = copy(
            &Side::Local,
            &src,
            &Side::remote(op.clone()),
            "/big.bin",
            0,
            &stop,
            WriteOpts::default(),
            |_| {},
        )
        .await;
        assert_eq!(r, Err(JobError::Stopped));
        assert!(!op.exists("big.bin").await.unwrap());
    }

    #[tokio::test]
    async fn remote_target_picks_a_free_name_without_replace() {
        let op = bucket();
        op.write("a.txt", b"x".to_vec()).await.unwrap();
        let side = Side::remote(op);
        assert_eq!(
            remote_target(&side, "/a.txt", true).await.unwrap(),
            "/a.txt"
        );
        assert_eq!(
            remote_target(&side, "/a.txt", false).await.unwrap(),
            "/a (copy).txt"
        );
        assert_eq!(
            remote_target(&side, "/b.txt", false).await.unwrap(),
            "/b.txt"
        );
    }

    #[test]
    fn opendal_err_classes() {
        use opendal::{Error, ErrorKind};
        let class = |k| opendal_err("x", Error::new(k, "m"));
        for k in [
            ErrorKind::NotFound,
            ErrorKind::PermissionDenied,
            ErrorKind::ConfigInvalid,
            ErrorKind::IsADirectory,
            ErrorKind::NotADirectory,
            ErrorKind::Unsupported,
        ] {
            assert!(matches!(class(k), JobError::Operation(_)), "{k:?}");
        }
        assert_eq!(
            class(ErrorKind::ConditionNotMatch),
            JobError::Operation(DEST_CHANGED.into())
        );
        for k in [ErrorKind::RateLimited, ErrorKind::Unexpected] {
            assert!(matches!(class(k), JobError::Connection(_)), "{k:?}");
        }
    }

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
            WriteOpts::default(),
            |n| seen.push(n),
        )
        .await
        .unwrap();
        assert_eq!(seen.last(), Some(&100));
        assert_eq!(
            finish(&Side::Local, &part, &dest, false, 0).await.unwrap(),
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
            WriteOpts::default(),
            |n| {
                first.get_or_insert(n);
            },
        )
        .await
        .unwrap();
        assert!(first.unwrap() > 40, "progress counts the resumed bytes too");
        finish(&Side::Local, &part, &dest, false, 0).await.unwrap();
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
            WriteOpts::default(),
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
        let r = copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            0,
            &stop,
            WriteOpts::default(),
            |_| {},
        )
        .await;
        assert_eq!(r, Err(JobError::Stopped));
        assert!(std::path::Path::new(&part).exists());
    }

    #[tokio::test]
    async fn finish_new_with_existing_dest_uses_free_name() {
        let d = Dir::new("free");
        let (part, dest) = (d.path("a.txt.x.part"), d.path("a.txt"));
        std::fs::write(&dest, b"mine").unwrap();
        std::fs::write(&part, b"new").unwrap();
        let landed = finish(&Side::Local, &part, &dest, false, 0).await.unwrap();
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
            finish(&Side::Local, &part, &dest, true, 0).await.unwrap(),
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
            WriteOpts::default(),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn stat_if_exists_tells_missing_from_unreadable() {
        use std::os::unix::fs::PermissionsExt;
        let d = Dir::new("statopt");
        let (src, _) = source(&d);
        assert_eq!(
            stat_if_exists(&Side::Local, &d.path("nope")).await.unwrap(),
            None
        );
        assert!(stat_if_exists(&Side::Local, &src).await.unwrap().is_some());
        let locked = d.path("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let inside = format!("{locked}/f");
        let r = stat_if_exists(&Side::Local, &inside).await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(r.is_err(), "a denied stat is not absence: {r:?}");
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
        let r = finish(&Side::Local, &d.path("missing.part"), &dest, false, 0).await;
        assert!(r.is_err());
        assert!(!std::path::Path::new(&dest).exists());
    }

    #[tokio::test]
    async fn publish_new_reserves_the_name_before_moving() {
        let d = Dir::new("reserve");
        let (part, dest) = (d.path("a.txt.x.part"), d.path("a.txt"));
        std::fs::write(&part, b"new").unwrap();
        assert_eq!(
            finish(&Side::Local, &part, &dest, false, 0).await.unwrap(),
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
    async fn published_file_keeps_the_source_mtime() {
        let d = Dir::new("mtime");
        let (src, _) = source(&d);
        let (part, dest) = (d.path("out.part"), d.path("out.bin"));
        copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            0,
            &CancellationToken::new(),
            WriteOpts::default(),
            |_| {},
        )
        .await
        .unwrap();
        finish(&Side::Local, &part, &dest, false, 1_600_000_000)
            .await
            .unwrap();
        assert_eq!(stat(&Side::Local, &dest).await.unwrap().1, 1_600_000_000);
    }

    #[tokio::test]
    async fn replace_publish_keeps_the_source_mtime() {
        let d = Dir::new("mtime-r");
        let (src, _) = source(&d);
        let (part, dest) = (d.path("out.part"), d.path("out.bin"));
        std::fs::write(&dest, b"old").unwrap();
        copy(
            &Side::Local,
            &src,
            &Side::Local,
            &part,
            0,
            &CancellationToken::new(),
            WriteOpts::default(),
            |_| {},
        )
        .await
        .unwrap();
        finish(&Side::Local, &part, &dest, true, 1_600_000_000)
            .await
            .unwrap();
        assert_eq!(stat(&Side::Local, &dest).await.unwrap().1, 1_600_000_000);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_running_upload_aborts_it() {
        let d = Dir::new("rdrop");
        let src = d.path("src.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let feeder = {
            let src = src.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let mut pipe = std::fs::OpenOptions::new().write(true).open(&src).unwrap();
                pipe.write_all(&[b'x'; 4096]).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(800));
            })
        };
        let before = REMOTE_ABORTS.load(std::sync::atomic::Ordering::SeqCst);
        let op = bucket();
        // Pause and cancel drop the whole run (the copy future), not just return an error.
        let run = tokio::spawn(async move {
            copy(
                &Side::Local,
                &src,
                &Side::remote(op),
                "/big.bin",
                0,
                &CancellationToken::new(),
                WriteOpts::default(),
                |_| {},
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        run.abort();
        let _ = run.await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(REMOTE_ABORTS.load(std::sync::atomic::Ordering::SeqCst) > before);
        feeder.join().unwrap();
    }

    #[tokio::test]
    async fn untrusted_certificate_fails_a_job_plainly() {
        let (port, _) = crate::storage::tls::tests::self_signed_server().await;
        let err = crate::storage::tls::client_for(None)
            .unwrap()
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
            .unwrap_err();
        let wrapped = opendal::Error::new(opendal::ErrorKind::Unexpected, "send").set_source(err);
        assert_eq!(
            opendal_err("write", wrapped),
            JobError::Operation(crate::storage::tls::CERT_UNTRUSTED.into())
        );
    }
}
