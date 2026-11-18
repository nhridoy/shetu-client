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
    async fn remove_part_deletes_file() {
        let d = Dir::new("rm");
        let part = d.path("o.part");
        std::fs::write(&part, b"x").unwrap();
        remove_part(&Side::Local, &part).await;
        assert!(!std::path::Path::new(&part).exists());
        remove_part(&Side::Local, &part).await; // already gone: no panic
    }
}
