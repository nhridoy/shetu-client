//! One transfer's I/O: connect what's missing, copy into the `.part`, publish. It owns no queue
//! state; everything it learns goes to the actor as a message (see `manager.rs`).

use super::actor::{owned_sid, End, Held, Lookup, RunEnd, Start};
use super::io::{self, Side};
use super::manager::Msg;
use super::model::*;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Manager as _;
use tokio::sync::{mpsc::UnboundedSender, oneshot};
use tokio_util::sync::CancellationToken;

const PROGRESS_EMIT_MS: i64 = 250;

/// Server-to-server copies always start over; the rest resume when they safely can.
pub fn offset_for(
    kind: JobKind,
    part_len: Option<u64>,
    snapshot: (u64, i64),
    now: (u64, i64),
) -> u64 {
    match kind {
        JobKind::ServerCopy => 0,
        JobKind::Download | JobKind::Upload => resume_offset(part_len, snapshot, now),
    }
}

/// A dismissed prompt, refused credentials or an untrusted host key won't fix themselves:
/// fail the job instead of retrying (and prompting) again.
pub fn connect_error_class(msg: &str) -> ErrorClass {
    let permanent = msg.contains(crate::ssh_auth::CANCELLED)
        || msg.contains("authentication rejected")
        || msg.contains("key not trusted")
        || crate::ssh::is_host_key_rejection(msg);
    if permanent {
        ErrorClass::Operation
    } else {
        ErrorClass::Connection
    }
}

pub struct Throttle {
    every_ms: i64,
    last: Option<i64>,
}

impl Throttle {
    pub fn new(every_ms: i64) -> Throttle {
        Throttle {
            every_ms,
            last: None,
        }
    }
    pub fn ready(&mut self, now: i64) -> bool {
        let ready = self.last.is_none_or(|last| now - last >= self.every_ms);
        if ready {
            self.last = Some(now);
        }
        ready
    }
}

/// One connect at a time per manager-owned session id, so parallel jobs share one sign-in.
#[derive(Default)]
pub struct ConnectLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl ConnectLocks {
    pub async fn lock(&self, sid: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = Arc::clone(
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .entry(sid.to_string())
                .or_default(),
        );
        lock.lock_owned().await
    }
}

/// Ends a run as soon as its token fires, wherever it is (connecting, a hung request).
async fn until_stopped<T>(
    stop: &CancellationToken,
    run: impl std::future::Future<Output = T>,
    stopped: T,
) -> T {
    tokio::select! {
        biased;
        _ = stop.cancelled() => stopped,
        end = run => end,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn finished(result: Result<(), JobError>) -> RunEnd {
    RunEnd::Finished {
        result,
        landed: None,
        published: None,
    }
}

struct Ctx<'a> {
    app: &'a tauri::AppHandle,
    tx: &'a UnboundedSender<Msg>,
    locks: &'a ConnectLocks,
    job: &'a TransferJob,
    run: u64,
}

impl Ctx<'_> {
    async fn ask(&self, end: End, connected: Option<String>) -> Lookup<Arc<SftpSession>> {
        let (reply, answer) = oneshot::channel();
        let msg = Msg::Lookup {
            id: self.job.id.clone(),
            run: self.run,
            end,
            connected,
            reply,
        };
        if self.tx.send(msg).is_err() {
            return Lookup::Fail(JobError::Stopped);
        }
        answer.await.unwrap_or(Lookup::Fail(JobError::Stopped))
    }

    /// The side for one end: this computer, the session handed over at start, or the
    /// manager's own connection, opened here (one connect per host at a time).
    async fn side(&self, end: End, held: Option<Held<Arc<SftpSession>>>) -> Result<Side, RunEnd> {
        let endpoint = match end {
            End::Src => &self.job.src,
            End::Dest => &self.job.dest,
        };
        // A bucket: an open pane's operator, or one built from the saved account. A missing
        // account won't come back on a retry.
        if let Some(r) = &endpoint.storage {
            return self
                .app
                .state::<crate::storage::sessions::StorageSessions>()
                .operator_for_ref(self.app, r)
                .map(Side::Remote)
                .map_err(|e| finished(Err(JobError::Operation(e))));
        }
        let Some(host) = &endpoint.host else {
            return Ok(Side::Local);
        };
        if let Some(h) = held {
            return Ok(Side::Sftp(h.handle));
        }
        let (Some(sid), Some(host_id)) = (owned_sid(host), host.host_id.clone()) else {
            return Err(RunEnd::Wait(WaitReason::Host));
        };
        let _turn = self.locks.lock(&sid).await;
        match self.ask(end, None).await {
            Lookup::Found(h) => return Ok(Side::Sftp(h.handle)),
            Lookup::Wait(r) => return Err(RunEnd::Wait(r)),
            Lookup::Fail(e) => return Err(finished(Err(e))),
            Lookup::Connect => {}
        }
        let connected = crate::sftp::connect_saved_session(
            self.app,
            sid.clone(),
            host_id,
            Some(host.username.clone()),
        )
        .await;
        if let Err(e) = connected {
            return Err(finished(Err(match connect_error_class(&e) {
                ErrorClass::Operation => JobError::Operation(e),
                ErrorClass::Connection => JobError::Connection(e),
            })));
        }
        match self.ask(end, Some(sid)).await {
            Lookup::Found(h) => Ok(Side::Sftp(h.handle)),
            Lookup::Wait(r) => Err(RunEnd::Wait(r)),
            Lookup::Fail(e) => Err(finished(Err(e))),
            Lookup::Connect => Err(finished(Err(JobError::Connection(
                "connect: session closed".into(),
            )))),
        }
    }

    /// Copies into the `.part` (for a bucket, straight to the final key); returns the source's
    /// (size, mtime) the copy was made from and the path written.
    async fn copy(
        &self,
        src: &Side,
        dst: &Side,
        stop: &CancellationToken,
    ) -> Result<((u64, i64), String), JobError> {
        let job = self.job;
        let snapshot = (job.src_size, job.src_mtime);
        let current = io::stat(src, &job.src.path).await?;
        let part_len = io::part_len(dst, &job.part_path).await?;
        let offset = offset_for(job.kind, part_len, snapshot, current);
        if current != snapshot {
            // Drop the old part first, so a crash after the new snapshot is saved can't pair it
            // with bytes from the previous version.
            io::discard_part(dst, &job.part_path).await?;
            let _ = self.tx.send(Msg::Restarted {
                id: job.id.clone(),
                run: self.run,
                snapshot: current,
            });
        }
        // A bucket upload writes the final key, so its name and the expected-version check
        // come first; "must not exist" is left to the write itself where the service can.
        let target = if matches!(dst, Side::Remote(_)) {
            let target = io::remote_target(dst, &job.dest.path, job.replace).await?;
            if let Some(expect) = job.expect_dest.filter(|e| *e != ABSENT) {
                check_expected_dest(Some(expect), io::stat_if_exists(dst, &target).await?)?;
            }
            target
        } else {
            job.part_path.clone()
        };
        let opts = io::WriteOpts {
            mtime: current.1,
            if_not_exists: job.expect_dest == Some(ABSENT),
        };
        let started = Instant::now();
        let mut emit = Throttle::new(PROGRESS_EMIT_MS);
        io::copy(
            src,
            &job.src.path,
            dst,
            &target,
            offset,
            stop,
            opts,
            |written| {
                if !emit.ready(now_ms()) {
                    return;
                }
                let secs = started.elapsed().as_secs_f64();
                let speed = if secs > 0.0 {
                    (written - offset) as f64 / secs
                } else {
                    0.0
                };
                let _ = self.tx.send(Msg::Progress {
                    id: job.id.clone(),
                    run: self.run,
                    written,
                    speed,
                });
            },
        )
        .await?;
        if stop.is_cancelled() {
            return Err(JobError::Stopped);
        }
        Ok((current, target))
    }

    /// Connects and copies. `Ok` hands back the destination, ready to publish.
    async fn prepare(
        &self,
        start_src: Option<Held<Arc<SftpSession>>>,
        start_dest: Option<Held<Arc<SftpSession>>>,
        stop: &CancellationToken,
    ) -> Result<(Side, i64, String), RunEnd> {
        let src = self.side(End::Src, start_src).await?;
        let dst = self.side(End::Dest, start_dest).await?;
        match self.copy(&src, &dst, stop).await {
            Ok(((_, mtime), written)) => Ok((dst, mtime, written)),
            Err(e) => Err(finished(Err(e))),
        }
    }
}

/// Moves the finished `.part` into place, first checking that the destination is still what the
/// job expects (if it says). "Must not exist" is enforced atomically (except on local
/// filesystems without hard links, see `publish_local_new`); an expected version is
/// best effort over SFTP: a save landing between the check and `finish`'s remove-then-rename
/// can still be replaced (no conditional rename in russh-sftp 2.4).
/// `mtime` is the source's time when it was copied (it may have changed since queueing).
/// Returns where it landed and the (size, mtime) it published, read from the `.part` once
/// its time is set (a rename keeps both), so it is this transfer's version, not a later one.
async fn publish(
    dst: &Side,
    job: &TransferJob,
    mtime: i64,
    written: &str,
) -> Result<(String, Option<(u64, i64)>), JobError> {
    // A bucket upload is already in place under the name `copy` chose.
    if matches!(dst, Side::Remote(_)) {
        return Ok((written.to_string(), io::stat(dst, written).await.ok()));
    }
    // The time is set first, so the destination check is the last step before the rename.
    if mtime > 0 {
        io::set_mtime(dst, &job.part_path, mtime).await;
    }
    let published = io::stat(dst, &job.part_path).await.ok();
    // "Must not exist" is published without replacing: a file that appears at the last moment
    // is never removed, and the copy that went elsewhere is taken back.
    if job.expect_dest == Some(ABSENT) {
        let landed = match io::finish(dst, &job.part_path, &job.dest.path, false, 0).await {
            Ok(landed) => landed,
            // SFTP rename refuses a target created after `finish` looked: that is the conflict,
            // anything else stays its own error.
            Err(e) => {
                return Err(match io::stat_if_exists(dst, &job.dest.path).await {
                    Ok(Some(_)) => JobError::Operation(DEST_CHANGED.into()),
                    _ => e,
                })
            }
        };
        if landed != job.dest.path {
            if let Err(e) = io::discard_part(dst, &landed).await {
                log::warn!("transfers: couldn't remove the stray copy at {landed}: {e:?}");
            }
            return Err(JobError::Operation(DEST_CHANGED.into()));
        }
        return Ok((landed, published));
    }
    if job.expect_dest.is_some() {
        let actual = io::stat_if_exists(dst, &job.dest.path).await?;
        check_expected_dest(job.expect_dest, actual)?;
    }
    let landed = io::finish(dst, &job.part_path, &job.dest.path, job.replace, 0).await?;
    Ok((landed, published))
}

/// Runs one transfer and reports how it ended. Publishing is not raced against Pause/Cancel:
/// once it starts, its real outcome is what the actor records.
pub async fn run(
    app: tauri::AppHandle,
    tx: UnboundedSender<Msg>,
    locks: Arc<ConnectLocks>,
    start: Start<Arc<SftpSession>>,
) {
    let Start {
        job,
        run,
        token,
        src,
        dest,
    } = start;
    let ctx = Ctx {
        app: &app,
        tx: &tx,
        locks: &locks,
        job: &job,
        run,
    };
    let stopped = Err(finished(Err(JobError::Stopped)));
    let end = match until_stopped(&token, ctx.prepare(src, dest, &token), stopped).await {
        Ok((dst, mtime, written)) => match publish(&dst, &job, mtime, &written).await {
            // `published` tells a module that queued this (an edit) the server state it
            // produced, even when the server kept its own mtime.
            Ok((landed, published)) => RunEnd::Finished {
                result: Ok(()),
                landed: (landed != job.dest.path).then_some(landed),
                published,
            },
            Err(e) => finished(Err(e)),
        },
        Err(end) => end,
    };
    let _ = tx.send(Msg::Ended {
        id: job.id.clone(),
        run,
        end,
    });
}

/// Deletes a cancelled job's `.part` wherever it can be reached (best effort).
pub async fn remove_part(app: tauri::AppHandle, job: TransferJob) {
    use tauri::Manager;
    match &job.dest.host {
        None => io::remove_part(&Side::Local, &job.part_path).await,
        Some(host) => {
            let found = app
                .state::<crate::sftp::SftpSessions>()
                .find_matching(host, None);
            if let Some((_, _, sftp)) = found {
                io::remove_part(&Side::Sftp(sftp), &job.part_path).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn local_publish_job(dir: &std::path::Path) -> TransferJob {
        let mut job = crate::transfers::queue::test_job("p", JobStatus::Queued);
        job.dest.host = None;
        job.dest.path = dir.join("a.txt").display().to_string();
        job.part_path = dir.join("a.txt.part").display().to_string();
        job.replace = true;
        job
    }

    #[tokio::test]
    async fn absent_never_replaces_a_file_that_appeared() {
        let dir = std::env::temp_dir().join(format!("shetu-pub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut job = local_publish_job(&dir);
        job.expect_dest = Some(crate::transfers::model::ABSENT);
        std::fs::write(&job.part_path, b"mine").unwrap();
        std::fs::write(&job.dest.path, b"theirs").unwrap();
        let r = publish(&Side::Local, &job, 0, &job.part_path).await;
        assert_eq!(
            r.map(|_| ()),
            Err(JobError::Operation(
                crate::transfers::model::DEST_CHANGED.into()
            ))
        );
        assert_eq!(std::fs::read(&job.dest.path).unwrap(), b"theirs");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|d| d.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.txt".to_string()], "no stray copy, no part");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn publish_reports_the_version_it_wrote() {
        let dir = std::env::temp_dir().join(format!("shetu-pub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let job = local_publish_job(&dir);
        std::fs::write(&job.part_path, b"hello").unwrap();
        let (landed, published) = publish(&Side::Local, &job, 1_600_000_000, &job.part_path)
            .await
            .unwrap();
        assert_eq!(landed, job.dest.path);
        assert_eq!(published, Some((5, 1_600_000_000)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_copy_offset_is_always_zero() {
        let s = (100, 7);
        assert_eq!(offset_for(JobKind::ServerCopy, Some(40), s, s), 0);
    }

    #[test]
    fn upload_offset_uses_resume_rule() {
        let s = (100, 7);
        assert_eq!(offset_for(JobKind::Upload, Some(40), s, s), 40);
        assert_eq!(offset_for(JobKind::Download, Some(40), s, (100, 9)), 0);
    }

    #[test]
    fn connect_error_classification() {
        assert_eq!(
            connect_error_class(crate::ssh_auth::CANCELLED),
            ErrorClass::Operation
        );
        assert_eq!(
            connect_error_class("authentication rejected"),
            ErrorClass::Operation
        );
        let rejected = format!("ssh handshake web:22: {}", russh::Error::UnknownKey);
        assert_eq!(connect_error_class(&rejected), ErrorClass::Operation);
        assert_eq!(
            connect_error_class("Jump host key not trusted"),
            ErrorClass::Operation
        );
        assert_eq!(
            connect_error_class("connect web:22: Connection refused"),
            ErrorClass::Connection
        );
    }

    #[tokio::test]
    async fn connects_to_one_session_id_take_turns() {
        let locks = ConnectLocks::default();
        let first = locks.lock("transfers:h1:me").await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), locks.lock("transfers:h1:me"))
                .await
                .is_err(),
            "second connect waits"
        );
        let _other = locks.lock("transfers:h2:me").await; // other hosts don't wait
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), locks.lock("transfers:h1:me"))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn stop_ends_a_hung_run() {
        let stop = CancellationToken::new();
        stop.cancel();
        let end = until_stopped(
            &stop,
            std::future::pending::<RunEnd>(),
            finished(Err(JobError::Stopped)),
        )
        .await;
        assert_eq!(end, finished(Err(JobError::Stopped)));
    }

    #[test]
    fn progress_throttle() {
        let mut t = Throttle::new(250);
        assert!(t.ready(0));
        assert!(!t.ready(100));
        assert!(t.ready(250));
        assert!(!t.ready(499));
    }
}
