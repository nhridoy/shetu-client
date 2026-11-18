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

    async fn copy(&self, src: &Side, dst: &Side, stop: &CancellationToken) -> Result<(), JobError> {
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
        let started = Instant::now();
        let mut emit = Throttle::new(PROGRESS_EMIT_MS);
        io::copy(
            src,
            &job.src.path,
            dst,
            &job.part_path,
            offset,
            stop,
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
        Ok(())
    }

    /// Connects and copies. `Ok` hands back the destination, ready to publish.
    async fn prepare(
        &self,
        start_src: Option<Held<Arc<SftpSession>>>,
        start_dest: Option<Held<Arc<SftpSession>>>,
        stop: &CancellationToken,
    ) -> Result<Side, RunEnd> {
        let src = self.side(End::Src, start_src).await?;
        let dst = self.side(End::Dest, start_dest).await?;
        match self.copy(&src, &dst, stop).await {
            Ok(()) => Ok(dst),
            Err(e) => Err(finished(Err(e))),
        }
    }
}

/// Moves the finished `.part` into place, first checking that the destination is still what the
/// job expects (if it says) so a changed server copy is never overwritten.
async fn publish(dst: &Side, job: &TransferJob) -> Result<String, JobError> {
    if job.expect_dest.is_some() {
        let actual = match io::stat(dst, &job.dest.path).await {
            Ok(found) => Some(found),
            Err(JobError::Operation(_)) => None,
            Err(e) => return Err(e),
        };
        check_expected_dest(job.expect_dest, actual)?;
    }
    io::finish(
        dst,
        &job.part_path,
        &job.dest.path,
        job.replace,
        job.src_mtime,
    )
    .await
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
        Ok(dst) => match publish(&dst, &job).await {
            Ok(landed) => RunEnd::Finished {
                result: Ok(()),
                landed: (landed != job.dest.path).then_some(landed),
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
