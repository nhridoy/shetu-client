//! The transfer manager: Tauri commands, the scheduling loop, retries and connections.

use super::io::{self, Side};
use super::model::*;
use super::queue::Queue;
use super::store;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub const CHANGED_EVENT: &str = "transfers://changed";
pub const RESET_EVENT: &str = "transfers://reset";
const OWNED_PREFIX: &str = "transfers:";
const OWNED_IDLE: Duration = Duration::from_secs(30);
const PROGRESS_EMIT_MS: i64 = 250;
const PROGRESS_SAVE_MS: i64 = 5_000;

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
    }
}

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

/// One cancel token per running job, tagged with a run number so a finished run can't remove
/// the token of a newer run of the same job.
#[derive(Default)]
pub struct RunTokens {
    next: u64,
    map: HashMap<String, (u64, CancellationToken)>,
}

impl RunTokens {
    pub fn start(&mut self, id: &str) -> (u64, CancellationToken) {
        self.next += 1;
        let token = CancellationToken::new();
        if let Some((_, old)) = self.map.insert(id.to_string(), (self.next, token.clone())) {
            old.cancel();
        }
        (self.next, token)
    }
    pub fn finish(&mut self, id: &str, run: u64) {
        if self.map.get(id).is_some_and(|(r, _)| *r == run) {
            self.map.remove(id);
        }
    }
    pub fn is_current(&self, id: &str, run: u64) -> bool {
        self.map.get(id).is_some_and(|(r, _)| *r == run)
    }
    pub fn is_running(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }
    pub fn cancel(&self, id: &str) {
        if let Some((_, t)) = self.map.get(id) {
            t.cancel();
        }
    }
    pub fn cancel_all(&self) {
        for (_, t) in self.map.values() {
            t.cancel();
        }
    }
}

/// Ends a run as soon as its token fires, wherever it is (connecting, a hung request, renaming).
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

/// The session a job reached is the machine it was queued for (a saved host may have been
/// edited since).
pub fn same_endpoint(recorded: &HostRef, actual: &HostRef) -> bool {
    recorded.host == actual.host
        && recorded.port == actual.port
        && recorded.username == actual.username
}

/// Applies a run's result and releases its ownership in one step, and only if it is still the
/// job's current run, so a replacement run can't start in between or be overwritten.
pub fn complete_run(
    tokens: &Mutex<RunTokens>,
    queue: &Mutex<Queue>,
    id: &str,
    run: u64,
    end: RunEnd,
    now: i64,
) -> Option<TransferJob> {
    let mut tokens = tokens.lock().unwrap_or_else(|p| p.into_inner());
    if !tokens.is_current(id, run) {
        return None;
    }
    let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
    let changed = match end {
        RunEnd::Wait(reason) => match q.get(id) {
            Some(j) if j.status == JobStatus::Active => {
                q.set_waiting(id, reason);
                q.get(id).cloned()
            }
            _ => None,
        },
        RunEnd::Finished(result) => q.finish(id, result, now).cloned(),
    };
    tokens.finish(id, run);
    changed
}

/// Adds freshly built jobs unless a wipe ran since `since`. Runs under the queue lock, which
/// `wipe_queue` also holds, so a wipe can't slip between the check and the commit.
pub fn commit_enqueue(
    queue: &Mutex<Queue>,
    epoch: &std::sync::atomic::AtomicU64,
    since: u64,
    jobs: Vec<TransferJob>,
    on_commit: impl FnOnce(&[TransferJob]),
) -> Result<(), String> {
    let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
    if epoch.load(std::sync::atomic::Ordering::SeqCst) != since {
        return Err("Signed out while queueing; nothing was queued".into());
    }
    q.enqueue(jobs.clone());
    on_commit(&jobs);
    Ok(())
}

/// Forgets the queue and bumps the epoch in one step under the queue lock.
pub fn wipe_queue(
    queue: &Mutex<Queue>,
    epoch: &std::sync::atomic::AtomicU64,
    on_wipe: impl FnOnce(),
) {
    let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
    epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    q.forget_all();
    on_wipe();
}

/// The session must describe the machine the job was queued for. No description (the session
/// went away or was replaced meanwhile) is not good enough either.
pub fn check_endpoint(recorded: &HostRef, actual: Option<&HostRef>) -> Result<(), JobError> {
    match actual {
        None => Err(JobError::Connection("connect: session closed".into())),
        Some(a) if !same_endpoint(recorded, a) => Err(JobError::Operation(format!(
            "{} now points to a different address than when this transfer was queued",
            recorded.host
        ))),
        Some(_) => Ok(()),
    }
}

/// When each manager-opened session was last used. Lookups that reuse a session and the idle
/// closer both go through this (under one lock), so a session can't be closed after a job
/// picked it up.
#[derive(Default)]
pub struct OwnedSessions(HashMap<String, Instant>);

impl OwnedSessions {
    pub fn touch(&mut self, sid: &str, now: Instant) {
        self.0.insert(sid.to_string(), now);
    }
    /// Stops tracking a session; true if it was tracked.
    pub fn forget(&mut self, sid: &str) -> bool {
        self.0.remove(sid).is_some()
    }
    pub fn is_owned(&self, sid: &str) -> bool {
        self.0.contains_key(sid)
    }
    /// Sessions unused for `idle` and not in `in_use`; they are forgotten here.
    pub fn retire_idle(&mut self, in_use: &[String], now: Instant, idle: Duration) -> Vec<String> {
        for sid in in_use {
            if let Some(at) = self.0.get_mut(sid) {
                *at = now;
            }
        }
        let retired: Vec<String> = self
            .0
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= idle)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in &retired {
            self.0.remove(sid);
        }
        retired
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Queued → Active plus its run token, in one step under the tokens lock (which `cancel_job`
/// also takes), so a cancel either stops the start or reaches the started run.
pub fn activate(
    tokens: &Mutex<RunTokens>,
    queue: &Mutex<Queue>,
    id: &str,
) -> Option<(u64, CancellationToken)> {
    let mut tokens = tokens.lock().unwrap_or_else(|p| p.into_inner());
    if tokens.is_running(id)
        || !queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .mark_active(id)
    {
        return None;
    }
    Some(tokens.start(id))
}

/// Cancels a job; also signals its run if one is live. Returns the job and whether a run owns
/// it (the run then deletes the `.part` once it lets go of the file).
pub fn cancel_job(
    tokens: &Mutex<RunTokens>,
    queue: &Mutex<Queue>,
    id: &str,
) -> Option<(TransferJob, bool)> {
    let tokens = tokens.lock().unwrap_or_else(|p| p.into_inner());
    let job = queue.lock().unwrap_or_else(|p| p.into_inner()).cancel(id)?;
    let running = tokens.is_running(id);
    tokens.cancel(id);
    Some((job, running))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

enum Acquire {
    Ready(Side, Option<String>),
    Wait(WaitReason),
    Fail(JobError),
}

pub enum RunEnd {
    Finished(Result<(), JobError>),
    Wait(WaitReason),
}

struct Inner {
    app: tauri::AppHandle,
    queue: Mutex<Queue>,
    tokens: Mutex<RunTokens>,
    connect_locks: ConnectLocks,
    /// Session each job was queued from (src, dest); memory only.
    prefer: Mutex<HashMap<String, (Option<String>, Option<String>)>>,
    /// Manager-opened sessions in use by running jobs.
    running: Mutex<HashMap<String, (u64, Vec<String>)>>,
    /// Bumped by a wipe; an enqueue that started before it doesn't commit.
    epoch: std::sync::atomic::AtomicU64,
    /// Manager-opened session id → last time a job used it.
    owned: Mutex<OwnedSessions>,
    notify: Notify,
}

#[derive(Clone)]
pub struct TransferManager {
    inner: Arc<Inner>,
}

impl TransferManager {
    /// Loads the saved queue (unfinished jobs come back paused) and starts the loop.
    pub fn new(app: tauri::AppHandle) -> TransferManager {
        let queue = restore_saved(&app.state::<crate::db::LocalDb>(), store::load_jobs);
        let inner = Arc::new(Inner {
            app: app.clone(),
            queue: Mutex::new(queue),
            tokens: Mutex::default(),
            connect_locks: ConnectLocks::default(),
            prefer: Mutex::default(),
            running: Mutex::default(),
            epoch: std::sync::atomic::AtomicU64::new(0),
            owned: Mutex::default(),
            notify: Notify::new(),
        });
        tauri::async_runtime::spawn(run_loop(Arc::clone(&inner)));
        TransferManager { inner }
    }

    /// Sign-out / device wipe: stop everything and forget the queue (`.part` files stay).
    pub fn wipe(&self) {
        let inner = &self.inner;
        inner
            .tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancel_all();
        // Under the queue lock, like an enqueue's commit, so the two can't interleave.
        wipe_queue(&inner.queue, &inner.epoch, || {
            inner
                .prefer
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
            let _ = store::clear_jobs(&inner.app.state::<crate::db::LocalDb>());
        });
        let _ = inner.app.emit(RESET_EVENT, ());
    }
}

impl Inner {
    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Saves and announces jobs whose status changed.
    fn changed(&self, jobs: Vec<TransferJob>) {
        if jobs.is_empty() {
            return;
        }
        let db = self.app.state::<crate::db::LocalDb>();
        for job in &jobs {
            if let Err(e) = store::save_job(&db, job) {
                log::warn!("transfers: {e}");
            }
        }
        let _ = self.app.emit(CHANGED_EVENT, &jobs);
    }

    fn changed_ids(&self, ids: &[String]) {
        let jobs: Vec<TransferJob> = {
            let q = self.queue();
            ids.iter().filter_map(|id| q.get(id).cloned()).collect()
        };
        self.changed(jobs);
    }

    fn unlocked(&self) -> bool {
        let crypto = self.app.state::<crate::CryptoState>();
        let session = crypto.session.lock().unwrap_or_else(|p| p.into_inner());
        session.unlocked
    }

    fn sessions(&self) -> tauri::State<'_, crate::sftp::SftpSessions> {
        self.app.state::<crate::sftp::SftpSessions>()
    }

    /// One pass of the loop. Returns whether there is anything left to watch.
    async fn tick(self: &Arc<Self>) -> bool {
        let now = now_ms();
        let due = self.queue().due(now);
        self.changed_ids(&due);

        let mut woken = Vec::new();
        if self.unlocked() {
            let ids = self.queue().waiting_for(WaitReason::Unlock);
            for id in ids {
                if self.queue().wake(&id) {
                    woken.push(id);
                }
            }
        }
        let host_waiters: Vec<TransferJob> = {
            let q = self.queue();
            q.waiting_for(WaitReason::Host)
                .iter()
                .filter_map(|id| q.get(id).cloned())
                .collect()
        };
        for job in host_waiters {
            let reachable = [&job.src, &job.dest].iter().all(|e| {
                e.host
                    .as_ref()
                    .is_none_or(|h| self.sessions().find_matching(h, None).is_some())
            });
            if reachable && self.queue().wake(&job.id) {
                woken.push(job.id);
            }
        }
        self.changed_ids(&woken);

        self.close_idle_owned().await;

        // A job whose previous run hasn't let go yet waits for the next pass.
        let mut start = Vec::new();
        let mut runs = Vec::new();
        // Collect first: a lock in the `for` expression would live through the loop body.
        let candidates = self.queue().startable();
        for id in candidates {
            if let Some(run) = activate(&self.tokens, &self.queue, &id) {
                start.push(id);
                runs.push(run);
            }
        }
        self.changed_ids(&start);
        for (id, (run, token)) in start.into_iter().zip(runs) {
            tauri::async_runtime::spawn(run_job(Arc::clone(self), id, run, token));
        }

        let busy = self.queue().all().iter().any(|j| {
            matches!(
                j.status,
                JobStatus::Queued | JobStatus::Active | JobStatus::Waiting
            )
        });
        busy || !self
            .owned
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty()
    }

    async fn drop_owned(&self, sids: Vec<String>) {
        let closing: Vec<crate::sftp::SftpSession> = {
            let mut owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
            sids.iter()
                .filter(|sid| owned.forget(sid))
                .filter_map(|sid| self.sessions().take(sid))
                .collect()
        };
        for session in closing {
            crate::sftp::close_session(session).await;
        }
    }

    async fn close_idle_owned(&self) {
        // Retired sessions leave the map while `owned` is locked, so a lookup that reuses a
        // session (also under `owned`) either refreshed it first or no longer finds it.
        let closing: Vec<crate::sftp::SftpSession> = {
            let mut owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
            let in_use: Vec<String> = self
                .running
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .flat_map(|(_, sids)| sids.iter().cloned())
                .collect();
            owned
                .retire_idle(&in_use, Instant::now(), OWNED_IDLE)
                .iter()
                .filter_map(|sid| self.sessions().take(sid))
                .collect()
        };
        for session in closing {
            crate::sftp::close_session(session).await;
        }
    }

    /// A side for one end of a job: this computer, an open session, or a fresh connection.
    /// A session for `host`, unless it now points somewhere else (the saved host was edited
    /// after the job was queued): the file must not go to a machine the user didn't pick.
    fn ready(
        &self,
        host: &HostRef,
        sid: String,
        actual: Option<&HostRef>,
        sftp: Arc<russh_sftp::client::SftpSession>,
    ) -> Acquire {
        if let Err(e) = check_endpoint(host, actual) {
            return Acquire::Fail(e);
        }
        let owned = sid.starts_with(OWNED_PREFIX).then_some(sid);
        Acquire::Ready(Side::Sftp(sftp), owned)
    }

    /// An open session to `host`; a manager-owned one is marked used in the same step.
    fn reuse(&self, host: &HostRef, prefer: Option<&str>) -> Option<Acquire> {
        let mut owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
        let (sid, actual, sftp) = self.sessions().find_matching(host, prefer)?;
        if owned.is_owned(&sid) {
            owned.touch(&sid, Instant::now());
        }
        drop(owned);
        Some(self.ready(host, sid, Some(&actual), sftp))
    }

    async fn acquire(&self, endpoint: &Endpoint, prefer: Option<&str>) -> Acquire {
        let Some(host) = &endpoint.host else {
            return Acquire::Ready(Side::Local, None);
        };
        if let Some(found) = self.reuse(host, prefer) {
            return found;
        }
        let Some(host_id) = &host.host_id else {
            return Acquire::Wait(WaitReason::Host);
        };
        if !self.unlocked() {
            return Acquire::Wait(WaitReason::Unlock);
        }
        let sid = format!("{OWNED_PREFIX}{host_id}:{}", host.username);
        // Jobs to the same host share one connect (and one prompt); later ones reuse it.
        let _turn = self.connect_locks.lock(&sid).await;
        if let Some(found) = self.reuse(host, prefer) {
            return found;
        }
        let connected = crate::sftp::connect_saved_session(
            &self.app,
            sid.clone(),
            host_id.clone(),
            Some(host.username.clone()),
        )
        .await;
        match connected {
            Ok(_) => {
                // Description and handle come from one lookup, so they belong together.
                let mut owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
                match self.sessions().session_info(&sid) {
                    Some((actual, sftp)) => {
                        owned.touch(&sid, Instant::now());
                        drop(owned);
                        self.ready(host, sid, Some(&actual), sftp)
                    }
                    None => Acquire::Fail(JobError::Connection("connect: session closed".into())),
                }
            }
            Err(e) => Acquire::Fail(match connect_error_class(&e) {
                ErrorClass::Operation => JobError::Operation(e),
                ErrorClass::Connection => JobError::Connection(e),
            }),
        }
    }

    /// Marks manager-owned sessions as in use by this run, so the idle closer leaves them alone.
    fn hold(&self, id: &str, run: u64, sid: Option<String>) {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let entry = running
            .entry(id.to_string())
            .or_insert_with(|| (run, Vec::new()));
        if entry.0 == run {
            entry.1.extend(sid);
        }
    }

    /// Connects both ends and copies into the `.part`. `Ok` hands back the destination, ready
    /// to publish; publishing runs outside the stop race (see `run_job`).
    async fn run(
        &self,
        job: &TransferJob,
        stop: &CancellationToken,
        run: u64,
    ) -> Result<Side, RunEnd> {
        let (prefer_src, prefer_dest) = self
            .prefer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&job.id)
            .cloned()
            .unwrap_or_default();
        let src = match self.acquire(&job.src, prefer_src.as_deref()).await {
            Acquire::Ready(side, owned) => {
                self.hold(&job.id, run, owned);
                side
            }
            Acquire::Wait(r) => return Err(RunEnd::Wait(r)),
            Acquire::Fail(e) => return Err(RunEnd::Finished(Err(e))),
        };
        let dst = match self.acquire(&job.dest, prefer_dest.as_deref()).await {
            Acquire::Ready(side, owned) => {
                self.hold(&job.id, run, owned);
                side
            }
            Acquire::Wait(r) => return Err(RunEnd::Wait(r)),
            Acquire::Fail(e) => return Err(RunEnd::Finished(Err(e))),
        };
        match self.copy_job(job, &src, &dst, stop).await {
            Ok(()) => Ok(dst),
            Err(e) => Err(RunEnd::Finished(Err(e))),
        }
    }

    /// Moves the finished `.part` into place. Never raced against Pause/Cancel: once started,
    /// its real outcome is what gets recorded.
    async fn publish(&self, job: &TransferJob, dst: &Side) -> Result<(), JobError> {
        let landed = io::finish(dst, &job.part_path, &job.dest.path, job.replace).await?;
        if landed != job.dest.path {
            if let Some(j) = self.queue().get_mut(&job.id) {
                j.dest.path = landed;
            }
        }
        Ok(())
    }

    async fn copy_job(
        &self,
        job: &TransferJob,
        src: &Side,
        dst: &Side,
        stop: &CancellationToken,
    ) -> Result<(), JobError> {
        let snapshot = (job.src_size, job.src_mtime);
        let current = io::stat(src, &job.src.path).await?;
        let part_len = io::part_len(dst, &job.part_path).await?;
        let offset = offset_for(job.kind, part_len, snapshot, current);
        if current != snapshot {
            // The source changed: drop the old part first, so a crash after saving the new
            // snapshot can't pair it with bytes from the previous version.
            io::discard_part(dst, &job.part_path).await?;
            let updated = {
                let mut q = self.queue();
                q.get_mut(&job.id).map(|j| {
                    (j.src_size, j.src_mtime) = current;
                    j.transferred = 0;
                    j.clone()
                })
            };
            self.changed(updated.into_iter().collect());
        }

        let started = Instant::now();
        let mut emit = Throttle::new(PROGRESS_EMIT_MS);
        let mut save = Throttle::new(PROGRESS_SAVE_MS);
        save.ready(now_ms());
        io::copy(
            src,
            &job.src.path,
            dst,
            &job.part_path,
            offset,
            stop,
            |written| {
                let now = now_ms();
                if !emit.ready(now) {
                    return;
                }
                let secs = started.elapsed().as_secs_f64();
                let snapshot = {
                    let mut q = self.queue();
                    let Some(j) = q.get_mut(&job.id).filter(|j| j.status == JobStatus::Active)
                    else {
                        return;
                    };
                    j.transferred = written;
                    j.speed = if secs > 0.0 {
                        (written - offset) as f64 / secs
                    } else {
                        0.0
                    };
                    j.clone()
                };
                if save.ready(now) {
                    let _ = store::save_job(&self.app.state::<crate::db::LocalDb>(), &snapshot);
                }
                let _ = self.app.emit(CHANGED_EVENT, [&snapshot]);
            },
        )
        .await?;

        if stop.is_cancelled() {
            return Err(JobError::Stopped);
        }
        Ok(())
    }

    /// Deletes a cancelled job's `.part` wherever it can be reached.
    async fn remove_part(&self, job: &TransferJob) {
        match &job.dest.host {
            None => io::remove_part(&Side::Local, &job.part_path).await,
            Some(host) => {
                if let Some((_, _, sftp)) = self.sessions().find_matching(host, None) {
                    io::remove_part(&Side::Sftp(sftp), &job.part_path).await;
                }
            }
        }
    }
}

async fn run_loop(inner: Arc<Inner>) {
    loop {
        if inner.tick().await {
            tokio::select! {
                _ = inner.notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        } else {
            inner.notify.notified().await;
        }
    }
}

async fn run_job(inner: Arc<Inner>, id: String, run: u64, token: CancellationToken) {
    let job = inner
        .queue()
        .get(&id)
        .filter(|j| j.status == JobStatus::Active)
        .cloned();
    let stopped = Err(RunEnd::Finished(Err(JobError::Stopped)));
    let end = match job {
        Some(job) => match until_stopped(&token, inner.run(&job, &token, run), stopped).await {
            Ok(dst) => RunEnd::Finished(inner.publish(&job, &dst).await),
            Err(end) => end,
        },
        None => RunEnd::Finished(Err(JobError::Stopped)),
    };
    let used = {
        let mut running = inner.running.lock().unwrap_or_else(|p| p.into_inner());
        match running.get(&id) {
            Some((r, _)) if *r == run => running.remove(&id).map(|(_, sids)| sids),
            _ => None,
        }
    };
    // A connection error on a manager-opened session (say the server closed just the SFTP
    // channel) must not be reused: drop it so the next attempt reconnects.
    if matches!(end, RunEnd::Finished(Err(JobError::Connection(_)))) {
        inner.drop_owned(used.unwrap_or_default()).await;
    }
    let changed = complete_run(&inner.tokens, &inner.queue, &id, run, end, now_ms());

    let cancelled = inner
        .queue()
        .get(&id)
        .filter(|j| j.status == JobStatus::Cancelled)
        .cloned();
    if let Some(job) = cancelled {
        inner.remove_part(&job).await;
    }
    if let Some(job) = changed {
        if job.status == JobStatus::Done {
            inner
                .prefer
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
        }
        inner.changed(vec![job]);
    }
    inner.notify.notify_one();
}

type Mgr<'a> = tauri::State<'a, TransferManager>;

#[tauri::command]
pub async fn transfer_enqueue(
    jobs: Vec<NewJob>,
    manager: Mgr<'_>,
) -> Result<Vec<TransferJob>, String> {
    let inner = &manager.inner;
    let epoch = inner.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let now = now_ms();
    let mut built = Vec::new();
    let mut prefer = Vec::new();
    for new in &jobs {
        let lookup = |sid: &Option<String>| -> Result<Option<(HostRef, Side)>, String> {
            match sid {
                None => Ok(None),
                Some(sid) => inner
                    .sessions()
                    .session_info(sid)
                    .map(|(host, sftp)| Some((host, Side::Sftp(sftp))))
                    .ok_or_else(|| "SFTP session not found".to_string()),
            }
        };
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
    let db = inner.app.state::<crate::db::LocalDb>();
    commit_enqueue(&inner.queue, &inner.epoch, epoch, built.clone(), |jobs| {
        inner
            .prefer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(prefer);
        for job in jobs {
            if let Err(e) = store::save_job(&db, job) {
                log::warn!("transfers: {e}");
            }
        }
    })?;
    let _ = inner.app.emit(CHANGED_EVENT, &built);
    inner.notify.notify_one();
    Ok(built)
}

#[tauri::command]
pub fn transfer_list(manager: Mgr<'_>) -> Vec<TransferJob> {
    manager.inner.queue().all().to_vec()
}

fn apply(manager: &TransferManager, ids: Vec<String>) {
    manager.inner.changed_ids(&ids);
    manager.inner.notify.notify_one();
}

#[tauri::command]
pub fn transfer_pause(id: String, manager: Mgr<'_>) -> Result<(), String> {
    if manager.inner.queue().pause(&id) {
        manager
            .inner
            .tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancel(&id);
        apply(&manager, vec![id]);
    }
    Ok(())
}

#[tauri::command]
pub fn transfer_resume(id: String, manager: Mgr<'_>) -> Result<(), String> {
    if manager.inner.queue().resume(&id) {
        apply(&manager, vec![id]);
    }
    Ok(())
}

#[tauri::command]
pub fn transfer_resume_all(manager: Mgr<'_>) -> Result<(), String> {
    let ids = manager.inner.queue().resume_all();
    apply(&manager, ids);
    Ok(())
}

#[tauri::command]
pub fn transfer_retry(id: String, manager: Mgr<'_>) -> Result<(), String> {
    if manager.inner.queue().retry(&id) {
        apply(&manager, vec![id]);
    }
    Ok(())
}

#[tauri::command]
pub fn transfer_cancel(id: String, manager: Mgr<'_>) -> Result<(), String> {
    let inner = &manager.inner;
    let Some((job, running)) = cancel_job(&inner.tokens, &inner.queue, &id) else {
        return Ok(());
    };
    inner
        .prefer
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);
    // A live run deletes the `.part` once it has let go of the file.
    if !running {
        let inner = Arc::clone(inner);
        tauri::async_runtime::spawn(async move { inner.remove_part(&job).await });
    }
    apply(&manager, vec![id]);
    Ok(())
}

#[tauri::command]
pub fn transfer_clear_finished(manager: Mgr<'_>) -> Result<(), String> {
    let removed = manager.inner.queue().clear_finished();
    store::delete_jobs(&manager.inner.app.state::<crate::db::LocalDb>(), &removed)
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

    #[test]
    fn finished_old_run_keeps_newer_runs_token() {
        let mut t = RunTokens::default();
        let (old, old_token) = t.start("a");
        let (new, new_token) = t.start("a");
        assert_ne!(old, new);
        assert!(old_token.is_cancelled(), "a replaced run is stopped");
        t.finish("a", old);
        assert!(t.is_running("a"));
        t.cancel("a");
        assert!(new_token.is_cancelled());
        t.finish("a", new);
        assert!(!t.is_running("a"));
    }

    #[test]
    fn cancel_all_stops_every_run() {
        let mut t = RunTokens::default();
        let (_, a) = t.start("a");
        let (_, b) = t.start("b");
        t.cancel_all();
        assert!(a.is_cancelled() && b.is_cancelled());
    }

    #[tokio::test]
    async fn stop_ends_a_hung_run() {
        let stop = CancellationToken::new();
        stop.cancel();
        let end = until_stopped(
            &stop,
            std::future::pending::<RunEnd>(),
            RunEnd::Finished(Err(JobError::Stopped)),
        )
        .await;
        assert!(matches!(end, RunEnd::Finished(Err(JobError::Stopped))));
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

    fn qmutex(jobs: Vec<TransferJob>) -> Mutex<Queue> {
        let mut q = Queue::default();
        q.enqueue(jobs);
        Mutex::new(q)
    }

    #[test]
    fn old_run_result_is_ignored_after_a_replacement() {
        let tokens = Mutex::new(RunTokens::default());
        let queue = qmutex(vec![crate::transfers::queue::test_job(
            "a",
            JobStatus::Active,
        )]);
        let (old, _) = tokens.lock().unwrap().start("a");
        let (new, _) = tokens.lock().unwrap().start("a");
        assert!(complete_run(&tokens, &queue, "a", old, RunEnd::Finished(Ok(())), 0).is_none());
        assert_eq!(
            queue.lock().unwrap().get("a").unwrap().status,
            JobStatus::Active
        );
        assert!(tokens.lock().unwrap().is_running("a"));
        let done = complete_run(&tokens, &queue, "a", new, RunEnd::Finished(Ok(())), 0).unwrap();
        assert_eq!(done.status, JobStatus::Done);
        assert!(!tokens.lock().unwrap().is_running("a"));
    }

    #[test]
    fn paused_then_resumed_run_ends_queued_and_released() {
        let tokens = Mutex::new(RunTokens::default());
        let queue = qmutex(vec![crate::transfers::queue::test_job(
            "a",
            JobStatus::Active,
        )]);
        let (run, _) = tokens.lock().unwrap().start("a");
        queue.lock().unwrap().pause("a");
        queue.lock().unwrap().resume("a");
        assert!(complete_run(
            &tokens,
            &queue,
            "a",
            run,
            RunEnd::Finished(Err(JobError::Stopped)),
            0
        )
        .is_none());
        assert_eq!(
            queue.lock().unwrap().get("a").unwrap().status,
            JobStatus::Queued
        );
        assert!(!tokens.lock().unwrap().is_running("a"));
    }

    #[test]
    fn wait_applies_only_to_an_active_job() {
        let tokens = Mutex::new(RunTokens::default());
        let queue = qmutex(vec![crate::transfers::queue::test_job(
            "a",
            JobStatus::Active,
        )]);
        let (run, _) = tokens.lock().unwrap().start("a");
        let j = complete_run(&tokens, &queue, "a", run, RunEnd::Wait(WaitReason::Host), 0).unwrap();
        assert_eq!(
            (j.status, j.wait_reason),
            (JobStatus::Waiting, Some(WaitReason::Host))
        );
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

    #[test]
    fn edited_saved_host_is_a_different_endpoint() {
        let recorded = host();
        assert!(same_endpoint(&recorded, &host()));
        let moved = HostRef {
            host: "new.example.com".into(),
            ..host()
        };
        assert!(!same_endpoint(&recorded, &moved));
        let other_port = HostRef {
            port: 2222,
            ..host()
        };
        assert!(!same_endpoint(&recorded, &other_port));
        let other_user = HostRef {
            username: "root".into(),
            ..host()
        };
        assert!(!same_endpoint(&recorded, &other_user));
    }

    #[test]
    fn commit_after_a_wipe_is_rejected() {
        let queue = Mutex::new(Queue::default());
        let epoch = std::sync::atomic::AtomicU64::new(0);
        let since = 0;
        let mut wiped = false;
        wipe_queue(&queue, &epoch, || wiped = true);
        assert!(wiped);
        let mut committed = false;
        let r = commit_enqueue(
            &queue,
            &epoch,
            since,
            vec![crate::transfers::queue::test_job("a", JobStatus::Queued)],
            |_| committed = true,
        );
        assert!(r.is_err());
        assert!(!committed);
        assert!(queue.lock().unwrap().all().is_empty());
    }

    #[test]
    fn commit_without_a_wipe_adds_and_saves() {
        let queue = Mutex::new(Queue::default());
        let epoch = std::sync::atomic::AtomicU64::new(3);
        let mut saved = Vec::new();
        commit_enqueue(
            &queue,
            &epoch,
            3,
            vec![crate::transfers::queue::test_job("a", JobStatus::Queued)],
            |jobs| saved = jobs.iter().map(|j| j.id.clone()).collect(),
        )
        .unwrap();
        assert_eq!(saved, vec!["a".to_string()]);
        assert_eq!(queue.lock().unwrap().all().len(), 1);
    }

    #[test]
    fn endpoint_check_fails_closed() {
        assert!(check_endpoint(&host(), Some(&host())).is_ok());
        assert!(matches!(
            check_endpoint(&host(), None),
            Err(JobError::Connection(_))
        ));
        let moved = HostRef {
            host: "new.example.com".into(),
            ..host()
        };
        assert!(matches!(
            check_endpoint(&host(), Some(&moved)),
            Err(JobError::Operation(_))
        ));
    }

    #[test]
    fn a_session_picked_up_is_not_retired() {
        let mut owned = OwnedSessions::default();
        let t0 = Instant::now();
        owned.touch("transfers:a", t0);
        owned.touch("transfers:b", t0);
        owned.touch("transfers:c", t0);
        let later = t0 + Duration::from_secs(31);
        owned.touch("transfers:b", later); // a job just reused it
        let retired =
            owned.retire_idle(&["transfers:c".to_string()], later, Duration::from_secs(30));
        assert_eq!(retired, vec!["transfers:a".to_string()]);
        assert!(!owned.is_owned("transfers:a"));
        assert!(owned.is_owned("transfers:b") && owned.is_owned("transfers:c"));
    }

    #[test]
    fn cancel_before_activation_stops_the_start() {
        let tokens = Mutex::new(RunTokens::default());
        let queue = qmutex(vec![crate::transfers::queue::test_job(
            "a",
            JobStatus::Queued,
        )]);
        let (job, running) = cancel_job(&tokens, &queue, "a").unwrap();
        assert_eq!((job.status, running), (JobStatus::Cancelled, false));
        assert!(activate(&tokens, &queue, "a").is_none());
        assert!(!tokens.lock().unwrap().is_running("a"));
    }

    #[test]
    fn cancel_after_activation_signals_the_run() {
        let tokens = Mutex::new(RunTokens::default());
        let queue = qmutex(vec![crate::transfers::queue::test_job(
            "a",
            JobStatus::Queued,
        )]);
        let (_, token) = activate(&tokens, &queue, "a").unwrap();
        assert_eq!(
            queue.lock().unwrap().get("a").unwrap().status,
            JobStatus::Active
        );
        let (_, running) = cancel_job(&tokens, &queue, "a").unwrap();
        assert!(running);
        assert!(token.is_cancelled());
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
    fn progress_throttle() {
        let mut t = Throttle::new(250);
        assert!(t.ready(0));
        assert!(!t.ready(100));
        assert!(t.ready(250));
        assert!(!t.ready(499));
    }
}
