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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

enum Acquire {
    Ready(Side, Option<String>),
    Wait(WaitReason),
    Fail(JobError),
}

enum RunEnd {
    Finished(Result<(), JobError>),
    Wait(WaitReason),
}

struct Inner {
    app: tauri::AppHandle,
    queue: Mutex<Queue>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    /// Session each job was queued from (src, dest); memory only.
    prefer: Mutex<HashMap<String, (Option<String>, Option<String>)>>,
    /// Manager-opened sessions in use by running jobs.
    running: Mutex<HashMap<String, Vec<String>>>,
    /// Manager-opened session id → last time a job used it.
    owned: Mutex<HashMap<String, Instant>>,
    notify: Notify,
}

#[derive(Clone)]
pub struct TransferManager {
    inner: Arc<Inner>,
}

impl TransferManager {
    /// Loads the saved queue (unfinished jobs come back paused) and starts the loop.
    pub fn new(app: tauri::AppHandle) -> TransferManager {
        let db = app.state::<crate::db::LocalDb>();
        let queue = Queue::restore(store::load_jobs(&db).unwrap_or_default());
        let _ = store::clear_jobs(&db);
        for job in queue.all() {
            let _ = store::save_job(&db, job);
        }
        let inner = Arc::new(Inner {
            app: app.clone(),
            queue: Mutex::new(queue),
            tokens: Mutex::default(),
            prefer: Mutex::default(),
            running: Mutex::default(),
            owned: Mutex::default(),
            notify: Notify::new(),
        });
        tauri::async_runtime::spawn(run_loop(Arc::clone(&inner)));
        TransferManager { inner }
    }

    /// Sign-out / device wipe: stop everything and forget the queue (`.part` files stay).
    pub fn wipe(&self) {
        for token in self
            .inner
            .tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
        {
            token.cancel();
        }
        self.inner
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .forget_all();
        self.inner
            .prefer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        let _ = store::clear_jobs(&self.inner.app.state::<crate::db::LocalDb>());
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

        let start = self.queue().startable();
        for id in &start {
            self.queue().mark_active(id);
        }
        self.changed_ids(&start);
        for id in start {
            tauri::async_runtime::spawn(run_job(Arc::clone(self), id));
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

    async fn close_idle_owned(&self) {
        let in_use: Vec<String> = self
            .running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .flatten()
            .cloned()
            .collect();
        let idle: Vec<String> = {
            let mut owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
            for id in &in_use {
                owned.insert(id.clone(), Instant::now());
            }
            let idle: Vec<String> = owned
                .iter()
                .filter(|(_, at)| at.elapsed() >= OWNED_IDLE)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &idle {
                owned.remove(id);
            }
            idle
        };
        for id in idle {
            self.sessions().disconnect(&id).await;
        }
    }

    /// A side for one end of a job: this computer, an open session, or a fresh connection.
    async fn acquire(&self, endpoint: &Endpoint, prefer: Option<&str>) -> Acquire {
        let Some(host) = &endpoint.host else {
            return Acquire::Ready(Side::Local, None);
        };
        if let Some((sid, sftp)) = self.sessions().find_matching(host, prefer) {
            let owned = sid.starts_with(OWNED_PREFIX).then_some(sid);
            return Acquire::Ready(Side::Sftp(sftp), owned);
        }
        let Some(host_id) = &host.host_id else {
            return Acquire::Wait(WaitReason::Host);
        };
        if !self.unlocked() {
            return Acquire::Wait(WaitReason::Unlock);
        }
        let sid = format!("{OWNED_PREFIX}{host_id}:{}", host.username);
        let connected = crate::sftp::connect_saved_session(
            &self.app,
            sid.clone(),
            host_id.clone(),
            Some(host.username.clone()),
        )
        .await;
        match connected {
            Ok(_) => match self.sessions().session_info(&sid) {
                Some((_, sftp)) => {
                    self.owned
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(sid.clone(), Instant::now());
                    Acquire::Ready(Side::Sftp(sftp), Some(sid))
                }
                None => Acquire::Fail(JobError::Connection("connect: session closed".into())),
            },
            Err(e) => Acquire::Fail(match connect_error_class(&e) {
                ErrorClass::Operation => JobError::Operation(e),
                ErrorClass::Connection => JobError::Connection(e),
            }),
        }
    }

    async fn run(&self, job: &TransferJob, stop: &CancellationToken) -> RunEnd {
        let (prefer_src, prefer_dest) = self
            .prefer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&job.id)
            .cloned()
            .unwrap_or_default();
        let mut used = Vec::new();
        let src = match self.acquire(&job.src, prefer_src.as_deref()).await {
            Acquire::Ready(side, owned) => {
                used.extend(owned);
                side
            }
            Acquire::Wait(r) => return RunEnd::Wait(r),
            Acquire::Fail(e) => return RunEnd::Finished(Err(e)),
        };
        let dst = match self.acquire(&job.dest, prefer_dest.as_deref()).await {
            Acquire::Ready(side, owned) => {
                used.extend(owned);
                side
            }
            Acquire::Wait(r) => return RunEnd::Wait(r),
            Acquire::Fail(e) => return RunEnd::Finished(Err(e)),
        };
        self.running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(job.id.clone(), used);
        RunEnd::Finished(self.copy_job(job, &src, &dst, stop).await)
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
            // The source changed: start over against its new size and time.
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
        let landed = io::finish(dst, &job.part_path, &job.dest.path, job.replace).await?;
        if landed != job.dest.path {
            if let Some(j) = self.queue().get_mut(&job.id) {
                j.dest.path = landed;
            }
        }
        Ok(())
    }

    /// Deletes a cancelled job's `.part` wherever it can be reached.
    async fn remove_part(&self, job: &TransferJob) {
        match &job.dest.host {
            None => io::remove_part(&Side::Local, &job.part_path).await,
            Some(host) => {
                if let Some((_, sftp)) = self.sessions().find_matching(host, None) {
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

async fn run_job(inner: Arc<Inner>, id: String) {
    let Some(job) = inner.queue().get(&id).cloned() else {
        return;
    };
    let token = CancellationToken::new();
    inner
        .tokens
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), token.clone());
    let end = inner.run(&job, &token).await;
    inner
        .tokens
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);
    inner
        .running
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);

    let changed = {
        let mut q = inner.queue();
        match end {
            RunEnd::Wait(reason) => match q.get(&id) {
                Some(j) if j.status == JobStatus::Active => {
                    q.set_waiting(&id, reason);
                    q.get(&id).cloned()
                }
                _ => None,
            },
            RunEnd::Finished(result) => q.finish(&id, result, now_ms()).cloned(),
        }
    };
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
        let snapshot = io::stat(src_side, &new.src_path)
            .await
            .map_err(|e| match e {
                JobError::Connection(m) | JobError::Operation(m) => {
                    format!("{}: {m}", new.src_path)
                }
                JobError::Stopped => format!("{}: stopped", new.src_path),
            })?;
        let job = build_job(
            new,
            src.map(|(h, _)| h),
            dest.map(|(h, _)| h),
            snapshot,
            now,
        );
        prefer.push((
            job.id.clone(),
            (new.src_session_id.clone(), new.dest_session_id.clone()),
        ));
        built.push(job);
    }
    inner
        .prefer
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .extend(prefer);
    inner.queue().enqueue(built.clone());
    inner.changed(built.clone());
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
        if let Some(t) = manager
            .inner
            .tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
        {
            t.cancel();
        }
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
    let was_active = manager
        .inner
        .queue()
        .get(&id)
        .is_some_and(|j| j.status == JobStatus::Active);
    let Some(job) = manager.inner.queue().cancel(&id) else {
        return Ok(());
    };
    manager
        .inner
        .prefer
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id);
    if was_active {
        // The running task deletes the `.part` once it has let go of the file.
        if let Some(t) = manager
            .inner
            .tokens
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
        {
            t.cancel();
        }
    } else {
        let inner = Arc::clone(&manager.inner);
        let job = job.clone();
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
    fn progress_throttle() {
        let mut t = Throttle::new(250);
        assert!(t.ready(0));
        assert!(!t.ready(100));
        assert!(t.ready(250));
        assert!(!t.ready(499));
    }
}
