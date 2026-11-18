//! Tauri glue for the transfer queue: commands send messages to one loop, which owns all
//! transfer state (`actor::State`) and carries out what it decides. Running transfers
//! (`worker.rs`) report back through the same channel.

use super::actor::{self, Effect, End, Env, Lookup, RunEnd, State};
use super::io::{self, Side};
use super::model::*;
use super::queue::Queue;
use super::store;
use super::worker::{self, ConnectLocks};
use russh_sftp::client::SftpSession;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

pub const CHANGED_EVENT: &str = "transfers://changed";
pub const RESET_EVENT: &str = "transfers://reset";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub kind: JobKind,
    pub src_path: String,
    pub dest_path: String,
    pub src_session_id: Option<String>,
    pub dest_session_id: Option<String>,
    pub replace: bool,
}

pub fn build_job(
    new: &NewJob,
    src_host: Option<HostRef>,
    dest_host: Option<HostRef>,
    snapshot: (u64, i64),
    now: i64,
) -> TransferJob {
    let id = uuid::Uuid::new_v4().to_string();
    TransferJob {
        part_path: part_path(&new.dest_path, &id),
        id,
        kind: new.kind,
        src: Endpoint {
            path: new.src_path.clone(),
            host: src_host,
        },
        dest: Endpoint {
            path: new.dest_path.clone(),
            host: dest_host,
        },
        replace: new.replace,
        src_size: snapshot.0,
        src_mtime: snapshot.1,
        status: JobStatus::Queued,
        transferred: 0,
        attempt: 0,
        next_retry_at: None,
        wait_reason: None,
        error: None,
        created_at: now,
        speed: 0.0,
        expect_dest: None,
    }
}

/// A job for a newly queued file; one whose source can't be read is created already failed.
pub fn job_for_stat(
    new: &NewJob,
    src_host: Option<HostRef>,
    dest_host: Option<HostRef>,
    stat: Result<(u64, i64), JobError>,
    now: i64,
) -> TransferJob {
    match stat {
        Ok(snapshot) => build_job(new, src_host, dest_host, snapshot, now),
        // Not reachable right now: queue it; the run stats again and retries like any drop.
        Err(JobError::Connection(_)) => build_job(new, src_host, dest_host, (0, 0), now),
        Err(e) => {
            let mut job = build_job(new, src_host, dest_host, (0, 0), now);
            let msg = match e {
                JobError::Connection(m) | JobError::Operation(m) => m,
                JobError::Stopped => "stopped".into(),
            };
            job.status = JobStatus::Failed;
            job.error = Some(format!("{}: {msg}", new.src_path));
            job
        }
    }
}

/// The saved queue at startup. A load error keeps the rows on disk (and starts empty) instead
/// of rewriting the table with nothing.
pub fn restore_saved(
    db: &crate::db::LocalDb,
    load: impl Fn(&crate::db::LocalDb) -> Result<Vec<TransferJob>, String>,
) -> Queue {
    match load(db) {
        Ok(jobs) => {
            let queue = Queue::restore(jobs);
            let _ = store::clear_jobs(db);
            for job in queue.all() {
                let _ = store::save_job(db, job);
            }
            queue
        }
        Err(e) => {
            log::warn!("transfers: could not load the saved queue: {e}");
            Queue::default()
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

type Prefer = Vec<(String, actor::PreferPair)>;

/// Everything the loop handles, one at a time.
pub enum Msg {
    Enqueue {
        jobs: Vec<TransferJob>,
        prefer: Prefer,
        epoch: u64,
        reply: oneshot::Sender<Result<Vec<TransferJob>, String>>,
    },
    Epoch(oneshot::Sender<u64>),
    List(oneshot::Sender<Vec<TransferJob>>),
    Pause(String),
    Resume(String),
    ResumeAll,
    Retry(String),
    Cancel(String),
    ClearFinished(oneshot::Sender<Result<(), String>>),
    Wipe(oneshot::Sender<()>),
    Lookup {
        id: String,
        run: u64,
        end: End,
        connected: Option<String>,
        reply: oneshot::Sender<Lookup<Arc<SftpSession>>>,
    },
    Progress {
        id: String,
        run: u64,
        written: u64,
        speed: f64,
    },
    Restarted {
        id: String,
        run: u64,
        snapshot: (u64, i64),
    },
    Ended {
        id: String,
        run: u64,
        end: RunEnd,
    },
}

/// The app's shared session map and lock state, as the actor sees them.
struct AppEnv {
    app: tauri::AppHandle,
    /// Sessions the actor removed; closed after each message.
    taken: Vec<crate::sftp::SftpSession>,
}

impl Env<Arc<SftpSession>> for AppEnv {
    fn unlocked(&self) -> bool {
        let crypto = self.app.state::<crate::CryptoState>();
        let session = crypto.session.lock().unwrap_or_else(|p| p.into_inner());
        session.unlocked
    }

    fn find(
        &self,
        host: &HostRef,
        prefer: Option<&str>,
        pane_ok: bool,
    ) -> Option<(String, HostRef, Arc<SftpSession>)> {
        let sessions = self.app.state::<crate::sftp::SftpSessions>();
        if pane_ok {
            sessions.find_matching(host, prefer)
        } else {
            sessions.get_open(&actor::owned_sid(host)?)
        }
    }

    fn take(&mut self, sid: &str) {
        if let Some(session) = self.app.state::<crate::sftp::SftpSessions>().take(sid) {
            self.taken.push(session);
        }
    }
}

#[derive(Clone)]
pub struct TransferManager {
    tx: mpsc::UnboundedSender<Msg>,
}

impl TransferManager {
    /// Loads the saved queue (unfinished jobs come back paused) and starts the loop.
    pub fn new(app: tauri::AppHandle) -> TransferManager {
        let queue = restore_saved(&app.state::<crate::db::LocalDb>(), store::load_jobs);
        let (tx, rx) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(run_loop(app, State::new(queue), rx, tx.clone()));
        TransferManager { tx }
    }

    fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> Result<T, String> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(msg(reply))
            .map_err(|_| "The transfer queue stopped".to_string())?;
        answer
            .await
            .map_err(|_| "The transfer queue stopped".to_string())
    }

    /// Sign-out / device wipe: stop everything and forget the queue (`.part` files stay).
    pub async fn wipe(&self) {
        let _ = self.ask(Msg::Wipe).await;
    }
}

async fn run_loop(
    app: tauri::AppHandle,
    mut state: State,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    tx: mpsc::UnboundedSender<Msg>,
) {
    let mut env = AppEnv {
        app: app.clone(),
        taken: Vec::new(),
    };
    let locks = Arc::new(ConnectLocks::default());
    loop {
        // Tick once a second while there is anything to watch; otherwise just wait.
        let msg = if state.busy() {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep(Duration::from_secs(1)) => None,
            }
        } else {
            rx.recv().await
        };
        // `None` is the tick (the loop's own sender keeps the channel open).
        let mut effects = match msg {
            // Answered only once their effects are applied: the caller then sees the table
            // already cleared (wipe) or the delete's outcome (clear).
            Some(Msg::Wipe(reply)) => {
                let _ = apply(&app, &tx, &locks, state.wipe());
                let _ = reply.send(());
                Vec::new()
            }
            Some(Msg::ClearFinished(reply)) => {
                let _ = reply.send(apply(&app, &tx, &locks, state.clear_finished()));
                Vec::new()
            }
            Some(msg) => handle(&mut state, msg, &mut env),
            None => Vec::new(),
        };
        effects.extend(state.tick(now_ms(), Instant::now(), &mut env));
        let _ = apply(&app, &tx, &locks, effects);
        for session in env.taken.drain(..) {
            tauri::async_runtime::spawn(crate::sftp::close_session(session));
        }
    }
}

fn handle(state: &mut State, msg: Msg, env: &mut AppEnv) -> Vec<Effect<Arc<SftpSession>>> {
    match msg {
        Msg::Enqueue {
            jobs,
            prefer,
            epoch,
            reply,
        } => {
            let result = state.enqueue(jobs.clone(), prefer, epoch);
            let (answer, effects) = match result {
                Ok(effects) => (Ok(jobs), effects),
                Err(e) => (Err(e), Vec::new()),
            };
            let _ = reply.send(answer);
            effects
        }
        Msg::Epoch(reply) => {
            let _ = reply.send(state.epoch());
            Vec::new()
        }
        Msg::List(reply) => {
            let _ = reply.send(state.list());
            Vec::new()
        }
        Msg::Pause(id) => state.pause(&id),
        Msg::Resume(id) => state.resume(&id),
        Msg::ResumeAll => state.resume_all(),
        Msg::Retry(id) => state.retry(&id),
        Msg::Cancel(id) => state.cancel(&id),
        // Handled in the loop: they answer after their effects are applied.
        Msg::ClearFinished(_) | Msg::Wipe(_) => Vec::new(),
        Msg::Lookup {
            id,
            run,
            end,
            connected,
            reply,
        } => {
            let _ =
                reply.send(state.lookup(&id, run, end, connected.as_deref(), Instant::now(), env));
            Vec::new()
        }
        Msg::Progress {
            id,
            run,
            written,
            speed,
        } => state.progress(&id, run, written, speed, now_ms()),
        Msg::Restarted { id, run, snapshot } => state.restarted(&id, run, snapshot),
        Msg::Ended { id, run, end } => state.ended(&id, run, end, now_ms(), env),
    }
}

/// Carries out the actor's decisions. Returns the first failed delete, so "Clear done" can
/// report it.
fn apply(
    app: &tauri::AppHandle,
    tx: &mpsc::UnboundedSender<Msg>,
    locks: &Arc<ConnectLocks>,
    effects: Vec<Effect<Arc<SftpSession>>>,
) -> Result<(), String> {
    let db = app.state::<crate::db::LocalDb>();
    let mut outcome = Ok(());
    for effect in effects {
        match effect {
            Effect::Changed(jobs) => {
                for job in &jobs {
                    if let Err(e) = store::save_job(&db, job) {
                        log::warn!("transfers: {e}");
                    }
                }
                let _ = app.emit(CHANGED_EVENT, &jobs);
            }
            Effect::Progress { job, save } => {
                if save {
                    let _ = store::save_job(&db, &job);
                }
                let _ = app.emit(CHANGED_EVENT, [&job]);
            }
            Effect::Delete(ids) => {
                if let Err(e) = store::delete_jobs(&db, &ids) {
                    log::warn!("transfers: {e}");
                    outcome = outcome.and(Err(e));
                }
            }
            Effect::Reset => {
                let _ = store::clear_jobs(&db);
                let _ = app.emit(RESET_EVENT, ());
            }
            Effect::Start(start) => {
                let (id, run) = (start.job.id.clone(), start.run);
                let task = tauri::async_runtime::spawn(worker::run(
                    app.clone(),
                    tx.clone(),
                    Arc::clone(locks),
                    start,
                ));
                // A transfer task that panics never reports; report for it, so the job fails
                // instead of staying Active forever.
                let tx = tx.clone();
                tauri::async_runtime::spawn(async move {
                    if task.await.is_err() {
                        let result = Err(JobError::Operation(
                            "The transfer stopped unexpectedly".into(),
                        ));
                        let end = RunEnd::Finished {
                            result,
                            landed: None,
                        };
                        let _ = tx.send(Msg::Ended { id, run, end });
                    }
                });
            }
            Effect::RemovePart(job) => {
                tauri::async_runtime::spawn(worker::remove_part(app.clone(), job));
            }
        }
    }
    outcome
}

type Mgr<'a> = tauri::State<'a, TransferManager>;

#[tauri::command]
pub async fn transfer_enqueue(
    jobs: Vec<NewJob>,
    manager: Mgr<'_>,
    app: tauri::AppHandle,
) -> Result<Vec<TransferJob>, String> {
    // Read before the slow part; a wipe meanwhile makes the enqueue be refused.
    let epoch = manager.ask(Msg::Epoch).await?;
    let sessions = app.state::<crate::sftp::SftpSessions>();
    let lookup = |sid: &Option<String>| -> Result<Option<(HostRef, Side)>, String> {
        match sid {
            None => Ok(None),
            Some(sid) => sessions
                .session_info(sid)
                .map(|(host, sftp)| Some((host, Side::Sftp(sftp))))
                .ok_or_else(|| "SFTP session not found".to_string()),
        }
    };
    let now = now_ms();
    let mut built = Vec::new();
    let mut prefer = Vec::new();
    for new in &jobs {
        let src = lookup(&new.src_session_id)?;
        let dest = lookup(&new.dest_session_id)?;
        let src_side = src.as_ref().map_or(&Side::Local, |(_, side)| side);
        // One unreadable file (a broken symlink, a file deleted meanwhile) fails on its own.
        let stat = io::stat(src_side, &new.src_path).await;
        let job = job_for_stat(new, src.map(|(h, _)| h), dest.map(|(h, _)| h), stat, now);
        prefer.push((
            job.id.clone(),
            (new.src_session_id.clone(), new.dest_session_id.clone()),
        ));
        built.push(job);
    }
    manager
        .ask(|reply| Msg::Enqueue {
            jobs: built,
            prefer,
            epoch,
            reply,
        })
        .await?
}

#[tauri::command]
pub async fn transfer_list(manager: Mgr<'_>) -> Result<Vec<TransferJob>, String> {
    manager.ask(Msg::List).await
}

#[tauri::command]
pub fn transfer_pause(id: String, manager: Mgr<'_>) -> Result<(), String> {
    manager.send(Msg::Pause(id));
    Ok(())
}

#[tauri::command]
pub fn transfer_resume(id: String, manager: Mgr<'_>) -> Result<(), String> {
    manager.send(Msg::Resume(id));
    Ok(())
}

#[tauri::command]
pub fn transfer_resume_all(manager: Mgr<'_>) -> Result<(), String> {
    manager.send(Msg::ResumeAll);
    Ok(())
}

#[tauri::command]
pub fn transfer_retry(id: String, manager: Mgr<'_>) -> Result<(), String> {
    manager.send(Msg::Retry(id));
    Ok(())
}

#[tauri::command]
pub fn transfer_cancel(id: String, manager: Mgr<'_>) -> Result<(), String> {
    manager.send(Msg::Cancel(id));
    Ok(())
}

#[tauri::command]
pub async fn transfer_clear_finished(manager: Mgr<'_>) -> Result<(), String> {
    manager.ask(Msg::ClearFinished).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostRef {
        HostRef {
            host_id: Some("h1".into()),
            host: "example.com".into(),
            port: 22,
            username: "me".into(),
        }
    }

    fn new_job(kind: JobKind) -> NewJob {
        NewJob {
            kind,
            src_path: "/r/a.tar".into(),
            dest_path: "/l/a.tar".into(),
            src_session_id: Some("pane-1".into()),
            dest_session_id: None,
            replace: true,
        }
    }

    #[test]
    fn new_job_from_download_has_remote_src_and_local_dest() {
        let j = build_job(
            &new_job(JobKind::Download),
            Some(host()),
            None,
            (100, 7),
            1234,
        );
        assert_eq!(
            j.src,
            Endpoint {
                path: "/r/a.tar".into(),
                host: Some(host())
            }
        );
        assert_eq!(
            j.dest,
            Endpoint {
                path: "/l/a.tar".into(),
                host: None
            }
        );
        assert_eq!(j.part_path, part_path("/l/a.tar", &j.id));
        assert!(j.part_path.ends_with(".part"));
        assert_eq!((j.src_size, j.src_mtime, j.created_at), (100, 7, 1234));
        assert_eq!(
            (j.status, j.transferred, j.attempt),
            (JobStatus::Queued, 0, 0)
        );
        assert!(j.replace);
        assert_eq!(j.id.len(), 36);
    }

    #[test]
    fn unreadable_source_is_queued_as_failed() {
        let new = new_job(JobKind::Download);
        let j = job_for_stat(
            &new,
            Some(host()),
            None,
            Err(JobError::Operation("stat: No such file".into())),
            5,
        );
        assert_eq!(j.status, JobStatus::Failed);
        assert_eq!(j.error.as_deref(), Some("/r/a.tar: stat: No such file"));
        let ok = job_for_stat(&new, Some(host()), None, Ok((100, 7)), 5);
        assert_eq!(
            (ok.status, ok.src_size, ok.error),
            (JobStatus::Queued, 100, None)
        );
    }

    #[test]
    fn unreachable_source_at_queue_time_is_retried_not_failed() {
        let new = new_job(JobKind::Download);
        let j = job_for_stat(
            &new,
            Some(host()),
            None,
            Err(JobError::Connection("stat: Timeout".into())),
            5,
        );
        assert_eq!((j.status, j.error), (JobStatus::Queued, None));
    }

    #[test]
    fn restore_saved_keeps_rows_when_load_fails() {
        let db = crate::db::open(":memory:").unwrap();
        store::save_job(
            &db,
            &crate::transfers::queue::test_job("a", JobStatus::Active),
        )
        .unwrap();
        let q = restore_saved(&db, |_| Err("disk I/O error".into()));
        assert!(q.all().is_empty());
        assert_eq!(
            store::load_jobs(&db).unwrap().len(),
            1,
            "rows survive a failed load"
        );
        let q = restore_saved(&db, store::load_jobs);
        assert_eq!(q.get("a").unwrap().status, JobStatus::Paused);
        assert_eq!(store::load_jobs(&db).unwrap()[0].status, JobStatus::Paused);
    }
}
