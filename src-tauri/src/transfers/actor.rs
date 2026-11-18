//! The single owner of all transfer state. Commands, the scheduler tick and running transfers
//! only send it events; every decision happens here, one event at a time, so no two of them can
//! interleave. Pure and synchronous: the Tauri loop in `manager.rs` feeds it and carries out the
//! effects it returns.

use super::model::*;
use super::queue::Queue;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const OWNED_PREFIX: &str = "transfers:";
pub const OWNED_IDLE: Duration = Duration::from_secs(30);
pub const PROGRESS_SAVE_MS: i64 = 5_000;

/// The shared SFTP session map and the lock state, as the actor sees them. `S` is a session
/// handle (`Arc<SftpSession>` in the app, a plain string in tests).
pub trait Env<S> {
    fn unlocked(&self) -> bool;
    /// An open session to `host`, `prefer` first. Without `pane_ok`, only the manager's own
    /// session counts. Returns its id, the host it is connected to, and its handle together.
    fn find(
        &self,
        host: &HostRef,
        prefer: Option<&str>,
        pane_ok: bool,
    ) -> Option<(String, HostRef, S)>;
    /// Removes a session from the shared map (the caller closes it).
    fn take(&mut self, sid: &str);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Src,
    Dest,
}

/// A session a run uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Held<S> {
    pub sid: String,
    pub handle: S,
}

/// What a run gets for one end when it asks.
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup<S> {
    Found(Held<S>),
    /// No usable session: the run should open the manager's own connection.
    Connect,
    Wait(WaitReason),
    Fail(JobError),
}

#[derive(Debug, Clone)]
pub struct Start<S> {
    pub job: TransferJob,
    pub run: u64,
    pub token: CancellationToken,
    /// `None` for this computer's side, or a remote side the run must connect itself.
    pub src: Option<Held<S>>,
    pub dest: Option<Held<S>>,
}

#[derive(Debug, Clone)]
pub enum Effect<S> {
    /// Save and announce.
    Changed(Vec<TransferJob>),
    /// Announce progress; `save` when its throttle allows.
    Progress {
        job: TransferJob,
        save: bool,
    },
    Delete(Vec<String>),
    /// The queue was wiped: clear the table, announce the reset.
    Reset,
    Start(Start<S>),
    RemovePart(TransferJob),
}

/// How a run ended. `landed` is where a published file actually went.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEnd {
    Finished {
        result: Result<(), JobError>,
        landed: Option<String>,
        /// The destination's (size, mtime) right after publishing.
        published: Option<(u64, i64)>,
    },
    Wait(WaitReason),
}

struct Run {
    run: u64,
    token: CancellationToken,
    /// Manager-owned sessions this run uses; never retired while held.
    held: Vec<String>,
}

/// The panes a job was queued from (source, destination), tried first for reuse.
pub type PreferPair = (Option<String>, Option<String>);

pub struct State {
    queue: Queue,
    runs: HashMap<String, Run>,
    next_run: u64,
    prefer: HashMap<String, PreferPair>,
    owned: HashMap<String, Instant>,
    last_saved: HashMap<String, i64>,
    epoch: u64,
}

/// The session id the manager uses for its own connection to a saved host.
pub fn owned_sid(host: &HostRef) -> Option<String> {
    Some(format!(
        "{OWNED_PREFIX}{}:{}",
        host.host_id.as_ref()?,
        host.username
    ))
}

pub fn same_endpoint(recorded: &HostRef, actual: &HostRef) -> bool {
    recorded.host == actual.host
        && recorded.port == actual.port
        && recorded.username == actual.username
}

/// After a failed attempt, a saved host's retries use only the manager's own connection: a
/// pane's may be the dead one. Quick-connect hosts have no other way in.
pub fn may_use_pane_session(job: &TransferJob, host: &HostRef) -> bool {
    job.attempt == 0 || host.host_id.is_none()
}

impl State {
    pub fn new(queue: Queue) -> State {
        State {
            queue,
            runs: HashMap::new(),
            next_run: 0,
            prefer: HashMap::new(),
            owned: HashMap::new(),
            last_saved: HashMap::new(),
            epoch: 0,
        }
    }

    pub fn list(&self) -> Vec<TransferJob> {
        self.queue.all().to_vec()
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Something to watch: unfinished jobs, live runs, or manager-owned sessions to retire.
    pub fn busy(&self) -> bool {
        let unfinished = self.queue.all().iter().any(|j| {
            matches!(
                j.status,
                JobStatus::Queued | JobStatus::Active | JobStatus::Waiting
            )
        });
        unfinished || !self.runs.is_empty() || !self.owned.is_empty()
    }

    fn changed<S>(&self, ids: &[String]) -> Vec<Effect<S>> {
        let jobs: Vec<TransferJob> = ids
            .iter()
            .filter_map(|id| self.queue.get(id).cloned())
            .collect();
        if jobs.is_empty() {
            Vec::new()
        } else {
            vec![Effect::Changed(jobs)]
        }
    }

    fn is_current(&self, id: &str, run: u64) -> bool {
        self.runs.get(id).is_some_and(|r| r.run == run)
    }

    /// Adds freshly built jobs unless a wipe happened since `epoch` was read.
    pub fn enqueue<S>(
        &mut self,
        jobs: Vec<TransferJob>,
        prefer: Vec<(String, PreferPair)>,
        epoch: u64,
    ) -> Result<Vec<Effect<S>>, String> {
        if epoch != self.epoch {
            return Err("Signed out while queueing; nothing was queued".into());
        }
        self.queue.enqueue(jobs.clone());
        self.prefer.extend(prefer);
        Ok(vec![Effect::Changed(jobs)])
    }

    pub fn pause<S>(&mut self, id: &str) -> Vec<Effect<S>> {
        if !self.queue.pause(id) {
            return Vec::new();
        }
        if let Some(r) = self.runs.get(id) {
            r.token.cancel();
        }
        self.changed(&[id.to_string()])
    }

    pub fn resume<S>(&mut self, id: &str) -> Vec<Effect<S>> {
        if self.queue.resume(id) {
            self.changed(&[id.to_string()])
        } else {
            Vec::new()
        }
    }

    pub fn resume_all<S>(&mut self) -> Vec<Effect<S>> {
        let ids = self.queue.resume_all();
        self.changed(&ids)
    }

    pub fn retry<S>(&mut self, id: &str) -> Vec<Effect<S>> {
        if self.queue.retry(id) {
            self.changed(&[id.to_string()])
        } else {
            Vec::new()
        }
    }

    pub fn cancel<S>(&mut self, id: &str) -> Vec<Effect<S>> {
        let Some(job) = self.queue.cancel(id) else {
            return Vec::new();
        };
        self.prefer.remove(id);
        let mut effects = self.changed(&[id.to_string()]);
        match self.runs.get(id) {
            // The run deletes the `.part` once it has let go of the file (see `ended`).
            Some(r) => r.token.cancel(),
            None => effects.push(Effect::RemovePart(job)),
        }
        effects
    }

    pub fn clear_finished<S>(&mut self) -> Vec<Effect<S>> {
        let runs = &self.runs;
        let removed = self.queue.clear_finished(|id| runs.contains_key(id));
        for id in &removed {
            self.prefer.remove(id);
            self.last_saved.remove(id);
        }
        if removed.is_empty() {
            Vec::new()
        } else {
            vec![Effect::Delete(removed)]
        }
    }

    pub fn wipe<S>(&mut self) -> Vec<Effect<S>> {
        for r in self.runs.values() {
            r.token.cancel();
        }
        self.runs.clear();
        self.queue.forget_all();
        self.prefer.clear();
        self.last_saved.clear();
        self.epoch += 1;
        vec![Effect::Reset]
    }

    /// Due retries, wake-ups, starting what can start, then retiring idle sessions (after the
    /// starts, so a session just handed to a run counts as in use).
    pub fn tick<S: Clone>(
        &mut self,
        now_ms: i64,
        now: Instant,
        env: &mut impl Env<S>,
    ) -> Vec<Effect<S>> {
        let mut touched = self.queue.due(now_ms);
        if env.unlocked() {
            for id in self.queue.waiting_for(WaitReason::Unlock) {
                if self.queue.wake(&id) {
                    touched.push(id);
                }
            }
        }
        for id in self.queue.waiting_for(WaitReason::Host) {
            let Some(job) = self.queue.get(&id) else {
                continue;
            };
            let reachable = [&job.src, &job.dest].iter().all(|e| {
                e.host
                    .as_ref()
                    .is_none_or(|h| env.find(h, None, true).is_some())
            });
            if reachable && self.queue.wake(&id) {
                touched.push(id);
            }
        }

        let mut starts = Vec::new();
        for id in self.queue.startable() {
            // The previous run of this job hasn't ended yet: wait for it.
            if self.runs.contains_key(&id) || !self.queue.mark_active(&id) {
                continue;
            }
            touched.push(id.clone());
            self.next_run += 1;
            let run = self.next_run;
            let token = CancellationToken::new();
            self.runs.insert(
                id.clone(),
                Run {
                    run,
                    token: token.clone(),
                    held: Vec::new(),
                },
            );
            let Some(job) = self.queue.get(&id).cloned() else {
                continue;
            };
            let src = self.lookup_end(&job, run, End::Src, None, now, env);
            let dest = self.lookup_end(&job, run, End::Dest, None, now, env);
            let mut ends = [src, dest].into_iter().map(|l| match l {
                None | Some(Lookup::Connect) => Ok(None),
                Some(Lookup::Found(h)) => Ok(Some(h)),
                Some(Lookup::Wait(r)) => Err(Err(r)),
                Some(Lookup::Fail(e)) => Err(Ok(e)),
            });
            match (ends.next().unwrap(), ends.next().unwrap()) {
                (Ok(src), Ok(dest)) => starts.push(Start {
                    job,
                    run,
                    token,
                    src,
                    dest,
                }),
                (Err(Ok(e)), _) | (_, Err(Ok(e))) => {
                    self.runs.remove(&id);
                    self.queue.finish(&id, Err(e), now_ms);
                }
                (Err(Err(r)), _) | (_, Err(Err(r))) => {
                    self.runs.remove(&id);
                    self.queue.set_waiting(&id, r);
                }
            }
        }

        // A session in use is never idle; its idle time counts from when the last run lets go.
        for sid in self.runs.values().flat_map(|r| &r.held) {
            if let Some(at) = self.owned.get_mut(sid) {
                *at = now;
            }
        }
        let idle: Vec<String> = self
            .owned
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= OWNED_IDLE)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in idle {
            self.owned.remove(&sid);
            env.take(&sid);
        }

        let mut effects = self.changed(&touched);
        effects.extend(starts.into_iter().map(Effect::Start));
        effects
    }

    /// The session for one end of a job: reuse (checking it still reaches the queued address),
    /// connect, wait, or fail. `None` for this computer's side.
    fn lookup_end<S: Clone>(
        &mut self,
        job: &TransferJob,
        run: u64,
        end: End,
        connected: Option<&str>,
        now: Instant,
        env: &mut impl Env<S>,
    ) -> Option<Lookup<S>> {
        let endpoint = match end {
            End::Src => &job.src,
            End::Dest => &job.dest,
        };
        let host = endpoint.host.as_ref()?;
        let preferred = self.prefer.get(&job.id).and_then(|(s, d)| match end {
            End::Src => s.clone(),
            End::Dest => d.clone(),
        });
        let prefer = connected.map(str::to_string).or(preferred);
        let Some((sid, actual, handle)) =
            env.find(host, prefer.as_deref(), may_use_pane_session(job, host))
        else {
            if connected.is_some() {
                return Some(Lookup::Fail(JobError::Connection(
                    "connect: session closed".into(),
                )));
            }
            if host.host_id.is_none() {
                return Some(Lookup::Wait(WaitReason::Host));
            }
            if !env.unlocked() {
                return Some(Lookup::Wait(WaitReason::Unlock));
            }
            return Some(Lookup::Connect);
        };
        if !same_endpoint(host, &actual) {
            return Some(Lookup::Fail(JobError::Operation(format!(
                "{} now points to a different address than when this transfer was queued",
                host.host
            ))));
        }
        if sid.starts_with(OWNED_PREFIX) {
            self.owned.insert(sid.clone(), now);
            if let Some(r) = self.runs.get_mut(&job.id).filter(|r| r.run == run) {
                r.held.push(sid.clone());
            }
        }
        Some(Lookup::Found(Held { sid, handle }))
    }

    /// A run asks for a session for one end; `connected` names the manager-owned session it
    /// just opened.
    pub fn lookup<S: Clone>(
        &mut self,
        id: &str,
        run: u64,
        end: End,
        connected: Option<&str>,
        now: Instant,
        env: &mut impl Env<S>,
    ) -> Lookup<S> {
        if let Some(sid) = connected {
            // Known from now on, so the idle closer eventually retires it.
            self.owned.insert(sid.to_string(), now);
        }
        let job = self
            .queue
            .get(id)
            .cloned()
            .filter(|_| self.is_current(id, run));
        let Some(job) = job else {
            return Lookup::Fail(JobError::Stopped);
        };
        self.lookup_end(&job, run, end, connected, now, env)
            .unwrap_or(Lookup::Fail(JobError::Operation("no remote end".into())))
    }

    pub fn progress<S>(
        &mut self,
        id: &str,
        run: u64,
        written: u64,
        speed: f64,
        now_ms: i64,
    ) -> Vec<Effect<S>> {
        if !self.is_current(id, run) {
            return Vec::new();
        }
        let Some(j) = self
            .queue
            .get_mut(id)
            .filter(|j| j.status == JobStatus::Active)
        else {
            return Vec::new();
        };
        j.transferred = written;
        j.speed = speed;
        let job = j.clone();
        let save = self
            .last_saved
            .get(id)
            .is_none_or(|at| now_ms - at >= PROGRESS_SAVE_MS);
        if save {
            self.last_saved.insert(id.to_string(), now_ms);
        }
        vec![Effect::Progress { job, save }]
    }

    /// The source changed since it was queued: the run restarts against its new size and time.
    pub fn restarted<S>(&mut self, id: &str, run: u64, snapshot: (u64, i64)) -> Vec<Effect<S>> {
        if !self.is_current(id, run) {
            return Vec::new();
        }
        let Some(j) = self.queue.get_mut(id) else {
            return Vec::new();
        };
        (j.src_size, j.src_mtime) = snapshot;
        j.transferred = 0;
        vec![Effect::Changed(vec![j.clone()])]
    }

    pub fn ended<S>(
        &mut self,
        id: &str,
        run: u64,
        end: RunEnd,
        now_ms: i64,
        env: &mut impl Env<S>,
    ) -> Vec<Effect<S>> {
        if !self.is_current(id, run) {
            return Vec::new();
        }
        let Some(finished) = self.runs.remove(id) else {
            return Vec::new();
        };
        let connection_error = matches!(
            &end,
            RunEnd::Finished {
                result: Err(JobError::Connection(_)),
                ..
            }
        );
        let changed = match end {
            RunEnd::Wait(reason) => match self.queue.get(id) {
                Some(j) if j.status == JobStatus::Active => {
                    self.queue.set_waiting(id, reason);
                    self.queue.get(id).cloned()
                }
                _ => None,
            },
            RunEnd::Finished {
                result,
                landed,
                published,
            } => {
                if let (Ok(()), Some(j)) = (&result, self.queue.get_mut(id)) {
                    if let Some(path) = landed {
                        j.dest.path = path;
                    }
                    j.published = published;
                }
                self.queue.finish(id, result, now_ms).cloned()
            }
        };
        // A manager-owned session that just failed may be dead (say, only its SFTP channel
        // closed): drop it so the next attempt reconnects.
        if connection_error {
            for sid in finished.held {
                self.owned.remove(&sid);
                env.take(&sid);
            }
        }
        let mut effects = Vec::new();
        if let Some(job) = changed {
            if job.status == JobStatus::Done {
                self.prefer.remove(id);
                self.last_saved.remove(id);
            }
            effects.push(Effect::Changed(vec![job]));
        }
        if let Some(job) = self
            .queue
            .get(id)
            .filter(|j| j.status == JobStatus::Cancelled)
        {
            effects.push(Effect::RemovePart(job.clone()));
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfers::queue::test_job;
    use JobStatus::*;

    #[derive(Default)]
    struct FakeEnv {
        locked: bool,
        /// sid → host it is connected to
        sessions: Vec<(String, HostRef)>,
        taken: Vec<String>,
    }

    impl Env<String> for FakeEnv {
        fn unlocked(&self) -> bool {
            !self.locked
        }
        fn find(
            &self,
            host: &HostRef,
            prefer: Option<&str>,
            pane_ok: bool,
        ) -> Option<(String, HostRef, String)> {
            let fits = |sid: &str, h: &HostRef| {
                let same = match &host.host_id {
                    Some(id) => h.host_id.as_ref() == Some(id) && h.username == host.username,
                    None => {
                        h.host == host.host && h.port == host.port && h.username == host.username
                    }
                };
                same && (pane_ok || sid.starts_with(OWNED_PREFIX))
            };
            let pick = prefer
                .and_then(|p| {
                    self.sessions
                        .iter()
                        .find(|(sid, h)| sid == p && fits(sid, h))
                })
                .or_else(|| self.sessions.iter().find(|(sid, h)| fits(sid, h)))?;
            Some((pick.0.clone(), pick.1.clone(), pick.0.clone()))
        }
        fn take(&mut self, sid: &str) {
            self.sessions.retain(|(s, _)| s != sid);
            self.taken.push(sid.to_string());
        }
    }

    fn saved() -> HostRef {
        HostRef {
            host_id: Some("h1".into()),
            host: "example.com".into(),
            port: 22,
            username: "me".into(),
        }
    }

    /// A download from the saved host to this computer.
    fn download(id: &str) -> TransferJob {
        let mut j = test_job(id, Queued);
        j.src.host = Some(saved());
        j
    }

    fn state_with(jobs: Vec<TransferJob>) -> State {
        let mut q = Queue::default();
        q.enqueue(jobs);
        State::new(q)
    }

    fn starts(effects: &[Effect<String>]) -> Vec<Start<String>> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Start(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    fn status(state: &State, id: &str) -> Option<JobStatus> {
        state
            .list()
            .into_iter()
            .find(|j| j.id == id)
            .map(|j| j.status)
    }

    fn pane(env: &mut FakeEnv) {
        env.sessions.push(("pane-1".into(), saved()));
    }

    fn ok() -> RunEnd {
        RunEnd::Finished {
            result: Ok(()),
            landed: None,
            published: None,
        }
    }

    fn start_one(state: &mut State, env: &mut FakeEnv) -> Start<String> {
        let effects = state.tick(0, Instant::now(), env);
        let mut s = starts(&effects);
        assert_eq!(s.len(), 1, "one start");
        s.remove(0)
    }

    // --- starting ---

    #[test]
    fn starts_at_most_three_with_the_pane_session_handed_over() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with((0..5).map(|i| download(&format!("j{i}"))).collect());
        let s = starts(&state.tick(0, Instant::now(), &mut env));
        assert_eq!(s.len(), 3);
        assert_eq!(
            s[0].src,
            Some(Held {
                sid: "pane-1".into(),
                handle: "pane-1".into()
            })
        );
        assert_eq!(s[0].dest, None);
        assert_eq!(status(&state, "j0"), Some(Active));
        assert_eq!(status(&state, "j3"), Some(Queued));
    }

    #[test]
    fn no_session_and_locked_waits_for_unlock_without_starting() {
        let mut env = FakeEnv {
            locked: true,
            ..Default::default()
        };
        let mut state = state_with(vec![download("a")]);
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
        let j = state.list().remove(0);
        assert_eq!(
            (j.status, j.wait_reason),
            (Waiting, Some(WaitReason::Unlock))
        );
        env.locked = false;
        let s = starts(&state.tick(0, Instant::now(), &mut env));
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].src, None, "no session yet: the run connects itself");
    }

    #[test]
    fn quick_connect_without_a_session_waits_for_the_host() {
        let mut env = FakeEnv::default();
        let mut job = download("a");
        job.src.host = Some(HostRef {
            host_id: None,
            ..saved()
        });
        let mut state = state_with(vec![job]);
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
        assert_eq!(state.list()[0].wait_reason, Some(WaitReason::Host));
        env.sessions.push((
            "pane-9".into(),
            HostRef {
                host_id: None,
                ..saved()
            },
        ));
        assert_eq!(starts(&state.tick(0, Instant::now(), &mut env)).len(), 1);
    }

    #[test]
    fn a_session_now_pointing_elsewhere_fails_closed() {
        let mut env = FakeEnv::default();
        env.sessions.push((
            "pane-1".into(),
            HostRef {
                host: "moved.example.com".into(),
                ..saved()
            },
        ));
        let mut state = state_with(vec![download("a")]);
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
        let j = state.list().remove(0);
        assert_eq!(j.status, Failed);
        assert!(j.error.unwrap().contains("different address"));
    }

    #[test]
    fn retries_to_a_saved_host_skip_pane_sessions() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut job = download("a");
        job.attempt = 1;
        let mut state = state_with(vec![job]);
        let s = start_one(&mut state, &mut env);
        assert_eq!(s.src, None, "pane session not reused on a retry");
    }

    // --- cancel / pause interleavings ---

    #[test]
    fn cancel_before_start_removes_the_part_and_never_starts() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let effects = state.cancel::<String>("a");
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::RemovePart(j) if j.id == "a")));
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
        assert_eq!(status(&state, "a"), Some(Cancelled));
    }

    #[test]
    fn cancel_while_running_signals_the_run_and_cleans_up_when_it_ends() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let effects = state.cancel::<String>("a");
        assert!(s.token.is_cancelled());
        assert!(
            !effects.iter().any(|e| matches!(e, Effect::RemovePart(_))),
            "the run still holds the file"
        );
        let end = RunEnd::Finished {
            result: Err(JobError::Stopped),
            landed: None,
            published: None,
        };
        let effects = state.ended("a", s.run, end, 0, &mut env);
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::RemovePart(j) if j.id == "a")));
        assert_eq!(status(&state, "a"), Some(Cancelled));
    }

    #[test]
    fn a_publish_that_landed_is_done_even_after_cancel() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        state.cancel::<String>("a");
        let effects = state.ended("a", s.run, ok(), 0, &mut env);
        assert_eq!(status(&state, "a"), Some(Done));
        assert!(!effects.iter().any(|e| matches!(e, Effect::RemovePart(_))));
    }

    #[test]
    fn pause_then_resume_while_the_run_ends_never_runs_twice() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        state.pause::<String>("a");
        assert!(s.token.is_cancelled());
        state.resume::<String>("a");
        // The old run hasn't ended yet: nothing new may start.
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
        let end = RunEnd::Finished {
            result: Err(JobError::Stopped),
            landed: None,
            published: None,
        };
        state.ended("a", s.run, end, 0, &mut env);
        assert_eq!(status(&state, "a"), Some(Queued));
        assert_eq!(starts(&state.tick(0, Instant::now(), &mut env)).len(), 1);
    }

    #[test]
    fn a_publish_that_landed_after_pause_and_resume_is_done() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        state.pause::<String>("a");
        state.resume::<String>("a");
        state.ended("a", s.run, ok(), 0, &mut env);
        assert_eq!(status(&state, "a"), Some(Done));
        assert!(starts(&state.tick(0, Instant::now(), &mut env)).is_empty());
    }

    #[test]
    fn clear_finished_keeps_a_cancelled_row_until_its_run_ends() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a"), {
            let mut d = download("d");
            d.status = Done;
            d
        }]);
        let s = start_one(&mut state, &mut env);
        state.cancel::<String>("a");
        let effects = state.clear_finished::<String>();
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::Delete(ids) if ids == &vec!["d".to_string()])));
        assert_eq!(status(&state, "a"), Some(Cancelled));
        let end = RunEnd::Finished {
            result: Err(JobError::Stopped),
            landed: None,
            published: None,
        };
        let effects = state.ended("a", s.run, end, 0, &mut env);
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::RemovePart(j) if j.id == "a")));
    }

    #[test]
    fn a_stale_run_ending_changes_nothing() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let effects = state.ended("a", s.run + 99, ok(), 0, &mut env);
        assert!(effects.is_empty());
        assert_eq!(status(&state, "a"), Some(Active));
    }

    // --- wipe ---

    #[test]
    fn an_enqueue_that_started_before_a_wipe_is_rejected() {
        let mut state = state_with(vec![]);
        let epoch = state.epoch();
        state.wipe::<String>();
        assert!(state
            .enqueue::<String>(vec![download("a")], vec![], epoch)
            .is_err());
        assert!(state.list().is_empty());
        let epoch = state.epoch();
        assert!(state
            .enqueue::<String>(vec![download("b")], vec![], epoch)
            .is_ok());
    }

    #[test]
    fn wipe_stops_runs_and_their_late_results_are_ignored() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let effects = state.wipe::<String>();
        assert!(s.token.is_cancelled());
        assert!(effects.iter().any(|e| matches!(e, Effect::Reset)));
        assert!(state.ended("a", s.run, ok(), 0, &mut env).is_empty());
        assert!(state.progress::<String>("a", s.run, 10, 1.0, 0).is_empty());
        assert!(state.list().is_empty());
    }

    // --- sessions ---

    #[test]
    fn a_connected_session_is_held_and_not_retired_while_in_use() {
        let mut env = FakeEnv::default();
        let mut state = state_with(vec![download("a")]);
        let t0 = Instant::now();
        let s = start_one(&mut state, &mut env);
        // The run opened the manager's own connection.
        env.sessions.push(("transfers:h1:me".into(), saved()));
        let got = state.lookup("a", s.run, End::Src, Some("transfers:h1:me"), t0, &mut env);
        assert_eq!(
            got,
            Lookup::Found(Held {
                sid: "transfers:h1:me".into(),
                handle: "transfers:h1:me".into()
            })
        );
        state.tick(0, t0 + Duration::from_secs(120), &mut env);
        assert!(env.taken.is_empty(), "held by a live run");
        state.ended("a", s.run, ok(), 0, &mut env);
        state.tick(0, t0 + Duration::from_secs(240), &mut env);
        assert_eq!(
            env.taken,
            vec!["transfers:h1:me".to_string()],
            "idle once released"
        );
    }

    #[test]
    fn a_session_held_through_a_long_run_stays_open_right_after() {
        let mut env = FakeEnv::default();
        let mut state = state_with(vec![download("a")]);
        let t0 = Instant::now();
        let s = start_one(&mut state, &mut env);
        env.sessions.push(("transfers:h1:me".into(), saved()));
        state.lookup::<String>("a", s.run, End::Src, Some("transfers:h1:me"), t0, &mut env);
        // A two-minute transfer: ticks keep running while it holds the session.
        state.tick(0, t0 + Duration::from_secs(60), &mut env);
        state.tick(0, t0 + Duration::from_secs(120), &mut env);
        state.ended("a", s.run, ok(), 0, &mut env);
        state.tick(0, t0 + Duration::from_secs(121), &mut env);
        assert!(
            env.taken.is_empty(),
            "idle time counts from release, not from hand-out"
        );
        state.tick(0, t0 + Duration::from_secs(151), &mut env);
        assert_eq!(env.taken, vec!["transfers:h1:me".to_string()]);
    }

    #[test]
    fn an_owned_session_handed_out_is_refreshed_not_retired() {
        let mut env = FakeEnv::default();
        env.sessions.push(("transfers:h1:me".into(), saved()));
        let mut state = state_with(vec![download("a"), download("b")]);
        let t0 = Instant::now();
        // Known as owned from an earlier run, idle for a while.
        state.lookup::<String>("x", 0, End::Src, Some("transfers:h1:me"), t0, &mut env);
        let effects = state.tick(0, t0 + Duration::from_secs(31), &mut env);
        // The same tick hands it to new runs, so it must not be taken.
        assert!(!starts(&effects).is_empty());
        assert!(env.taken.is_empty());
    }

    #[test]
    fn a_connection_error_drops_the_runs_owned_session() {
        let mut env = FakeEnv::default();
        env.sessions.push(("transfers:h1:me".into(), saved()));
        let mut state = state_with(vec![download("a")]);
        let t0 = Instant::now();
        state.lookup::<String>("x", 0, End::Src, Some("transfers:h1:me"), t0, &mut env);
        let s = start_one(&mut state, &mut env);
        assert_eq!(
            s.src.as_ref().map(|h| h.sid.as_str()),
            Some("transfers:h1:me")
        );
        let end = RunEnd::Finished {
            result: Err(JobError::Connection("channel closed".into())),
            landed: None,
            published: None,
        };
        state.ended("a", s.run, end, 1000, &mut env);
        assert_eq!(env.taken, vec!["transfers:h1:me".to_string()]);
        let j = state.list().remove(0);
        assert_eq!((j.status, j.attempt), (Waiting, 1));
    }

    #[test]
    fn lookup_for_a_pane_less_retry_asks_to_connect() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut job = download("a");
        job.attempt = 2;
        let mut state = state_with(vec![job]);
        let s = start_one(&mut state, &mut env);
        assert_eq!(
            state.lookup::<String>("a", s.run, End::Src, None, Instant::now(), &mut env),
            Lookup::Connect
        );
    }

    #[test]
    fn lookup_while_locked_waits() {
        let mut env = FakeEnv::default();
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        env.locked = true;
        assert_eq!(
            state.lookup::<String>("a", s.run, End::Src, None, Instant::now(), &mut env),
            Lookup::Wait(WaitReason::Unlock)
        );
    }

    // --- progress, restart, landing ---

    #[test]
    fn progress_updates_and_saves_at_most_every_five_seconds() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let saves = |effects: Vec<Effect<String>>| match &effects[..] {
            [Effect::Progress { job, save }] => (job.transferred, *save),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            saves(state.progress("a", s.run, 10, 1.0, 10_000)),
            (10, true)
        );
        assert_eq!(
            saves(state.progress("a", s.run, 20, 1.0, 12_000)),
            (20, false)
        );
        assert_eq!(
            saves(state.progress("a", s.run, 30, 1.0, 15_000)),
            (30, true)
        );
    }

    #[test]
    fn a_changed_source_resets_progress_and_snapshot() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        state.progress::<String>("a", s.run, 40, 1.0, 0);
        state.restarted::<String>("a", s.run, (500, 9));
        let j = state.list().remove(0);
        assert_eq!((j.src_size, j.src_mtime, j.transferred), (500, 9, 0));
    }

    #[test]
    fn the_published_state_is_recorded() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let end = RunEnd::Finished {
            result: Ok(()),
            landed: None,
            published: Some((5, 9)),
        };
        state.ended("a", s.run, end, 0, &mut env);
        assert_eq!(state.list()[0].published, Some((5, 9)));
    }

    #[test]
    fn a_landed_name_is_recorded() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let end = RunEnd::Finished {
            result: Ok(()),
            landed: Some("/l/a (copy)".into()),
            published: None,
        };
        state.ended("a", s.run, end, 0, &mut env);
        assert_eq!(state.list()[0].dest.path, "/l/a (copy)");
    }

    #[test]
    fn retry_schedule_runs_through_tick() {
        let mut env = FakeEnv::default();
        pane(&mut env);
        let mut state = state_with(vec![download("a")]);
        let s = start_one(&mut state, &mut env);
        let end = RunEnd::Finished {
            result: Err(JobError::Connection("reset".into())),
            landed: None,
            published: None,
        };
        state.ended("a", s.run, end, 1_000, &mut env);
        assert!(starts(&state.tick(2_999, Instant::now(), &mut env)).is_empty());
        assert_eq!(
            starts(&state.tick(3_000, Instant::now(), &mut env)).len(),
            1
        );
    }

    #[test]
    fn busy_reflects_unfinished_work() {
        let mut state = state_with(vec![]);
        assert!(!state.busy());
        let epoch = state.epoch();
        state
            .enqueue::<String>(vec![download("a")], vec![], epoch)
            .unwrap();
        assert!(state.busy());
    }
}
