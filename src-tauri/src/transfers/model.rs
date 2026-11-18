//! Job types and the pure rules: `.part` names, resume offsets, retry delays, error classes.

use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const MAX_ACTIVE: usize = 3;
pub const MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRef {
    /// Some = a saved host the manager may reconnect itself.
    pub host_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub path: String,
    /// None = this computer.
    pub host: Option<HostRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Download,
    Upload,
    ServerCopy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Active,
    Paused,
    Waiting,
    Failed,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WaitReason {
    Retry,
    Unlock,
    Host,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    pub kind: JobKind,
    pub src: Endpoint,
    pub dest: Endpoint,
    /// The user approved replacing an existing destination.
    pub replace: bool,
    pub part_path: String,
    pub src_size: u64,
    pub src_mtime: i64,
    pub status: JobStatus,
    pub transferred: u64,
    pub attempt: u32,
    pub next_retry_at: Option<i64>,
    pub wait_reason: Option<WaitReason>,
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub speed: f64,
    /// The destination's (size, mtime) that must still hold when publishing; a mismatch fails
    /// the job with `DEST_CHANGED` instead of overwriting.
    #[serde(default)]
    pub expect_dest: Option<(u64, i64)>,
    /// The destination's (size, mtime) right after this job published it.
    #[serde(default)]
    pub published: Option<(u64, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobError {
    Connection(String),
    Operation(String),
    /// The job's own token fired (pause, cancel, shutdown).
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Connection,
    Operation,
}

pub const DEST_CHANGED: &str = "conflict: the server copy changed";

pub fn check_expected_dest(
    expect: Option<(u64, i64)>,
    actual: Option<(u64, i64)>,
) -> Result<(), JobError> {
    match expect {
        Some(expected) if actual != Some(expected) => Err(JobError::Operation(DEST_CHANGED.into())),
        _ => Ok(()),
    }
}

pub fn part_path(dest: &str, id: &str) -> String {
    let short: String = id.chars().take(8).collect();
    format!("{dest}.{short}.part")
}

/// Where a resumed copy continues: the `.part` size, or 0 when the source changed or the
/// `.part` can't belong to it.
pub fn resume_offset(part_len: Option<u64>, snapshot: (u64, i64), now: (u64, i64)) -> u64 {
    match part_len {
        Some(len) if snapshot == now && len <= now.0 => len,
        _ => 0,
    }
}

pub fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(2u64.saturating_pow(attempt).min(60))
}

pub fn classify_io(e: &std::io::Error) -> ErrorClass {
    use std::io::ErrorKind::*;
    if let Some(inner) = e
        .get_ref()
        .and_then(|r| r.downcast_ref::<russh_sftp::client::error::Error>())
    {
        return classify_sftp(inner);
    }
    match e.kind() {
        NotFound | PermissionDenied | AlreadyExists | InvalidInput | IsADirectory
        | NotADirectory | StorageFull | ReadOnlyFilesystem | FileTooLarge | InvalidFilename => {
            ErrorClass::Operation
        }
        _ => ErrorClass::Connection,
    }
}

pub fn classify_sftp(e: &russh_sftp::client::error::Error) -> ErrorClass {
    use russh_sftp::client::error::Error;
    use russh_sftp::protocol::StatusCode;
    match e {
        Error::Status(s) => match s.status_code {
            StatusCode::NoSuchFile | StatusCode::PermissionDenied | StatusCode::OpUnsupported => {
                ErrorClass::Operation
            }
            _ => ErrorClass::Connection,
        },
        _ => ErrorClass::Connection,
    }
}

/// The next free name, using the same rule as `generateAutoName` in `fileTransfer.ts`:
/// `<base> (copy)<ext>`, then `<base> (copy N)<ext>` from 2.
pub fn free_name(dest: &str, exists: impl Fn(&str) -> bool) -> String {
    let split = dest.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let (dir, name) = dest.split_at(split);
    let (base, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut candidate = format!("{dir}{base} (copy){ext}");
    let mut n = 2;
    while exists(&candidate) {
        candidate = format!("{dir}{base} (copy {n}){ext}");
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::client::error::Error as SftpError;
    use russh_sftp::protocol::{Status, StatusCode};

    #[test]
    fn expected_dest_rules() {
        assert!(check_expected_dest(None, None).is_ok());
        assert!(check_expected_dest(Some((10, 5)), Some((10, 5))).is_ok());
        assert_eq!(
            check_expected_dest(Some((10, 5)), Some((11, 5))),
            Err(JobError::Operation(DEST_CHANGED.into()))
        );
        assert_eq!(
            check_expected_dest(Some((10, 5)), None),
            Err(JobError::Operation(DEST_CHANGED.into()))
        );
    }

    #[test]
    fn part_path_uses_first_8_chars_of_id() {
        assert_eq!(
            part_path("/d/a.tar", "1a2b3c4d-9999"),
            "/d/a.tar.1a2b3c4d.part"
        );
    }

    #[test]
    fn resume_offset_rules() {
        let s = (100, 7);
        assert_eq!(resume_offset(None, s, s), 0);
        assert_eq!(resume_offset(Some(40), s, s), 40);
        assert_eq!(resume_offset(Some(100), s, s), 100);
        assert_eq!(resume_offset(Some(101), s, s), 0);
        assert_eq!(resume_offset(Some(40), s, (100, 8)), 0);
        assert_eq!(resume_offset(Some(40), s, (120, 7)), 0);
    }

    #[test]
    fn retry_delay_schedule() {
        let secs: Vec<u64> = (1..=5).map(|a| retry_delay(a).as_secs()).collect();
        assert_eq!(secs, vec![2, 4, 8, 16, 32]);
        assert_eq!(retry_delay(9).as_secs(), 60);
    }

    #[test]
    fn classify_io_not_found_is_operation() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            classify_io(&Error::from(ErrorKind::NotFound)),
            ErrorClass::Operation
        );
        assert_eq!(
            classify_io(&Error::from(ErrorKind::PermissionDenied)),
            ErrorClass::Operation
        );
        assert_eq!(
            classify_io(&Error::from(ErrorKind::ConnectionReset)),
            ErrorClass::Connection
        );
        assert_eq!(classify_io(&Error::other("??")), ErrorClass::Connection);
    }

    fn status(code: StatusCode) -> SftpError {
        SftpError::Status(Status {
            id: 0,
            status_code: code,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }

    #[test]
    fn classify_sftp_status_codes() {
        assert_eq!(
            classify_sftp(&status(StatusCode::NoSuchFile)),
            ErrorClass::Operation
        );
        assert_eq!(
            classify_sftp(&status(StatusCode::PermissionDenied)),
            ErrorClass::Operation
        );
        assert_eq!(
            classify_sftp(&status(StatusCode::OpUnsupported)),
            ErrorClass::Operation
        );
        assert_eq!(
            classify_sftp(&status(StatusCode::Failure)),
            ErrorClass::Connection
        );
        assert_eq!(classify_sftp(&SftpError::Timeout), ErrorClass::Connection);
        assert_eq!(
            classify_sftp(&SftpError::IO("eof".into())),
            ErrorClass::Connection
        );
    }

    #[test]
    fn classify_io_unwraps_sftp_status() {
        // russh-sftp file reads/writes surface SFTP errors wrapped in io::Error::other.
        let e = std::io::Error::other(status(StatusCode::PermissionDenied));
        assert_eq!(classify_io(&e), ErrorClass::Operation);
    }

    #[test]
    fn free_name_follows_copy_rule() {
        let taken = ["/d/a.txt", "/d/a (copy).txt"];
        assert_eq!(
            free_name("/d/a.txt", |p| taken.contains(&p)),
            "/d/a (copy 2).txt"
        );
        assert_eq!(free_name("/d/noext", |_| false), "/d/noext (copy)");
        assert_eq!(free_name("C:\\d\\.env", |_| false), "C:\\d\\.env (copy)");
    }
}
