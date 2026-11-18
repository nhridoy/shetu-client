//! The queue's state machine. Pure: callers pass `now` and do the I/O.

use super::model::*;

#[derive(Debug, Default)]
pub struct Queue {
    /// Insertion order = age.
    jobs: Vec<TransferJob>,
}

impl Queue {
    /// After a restart nothing runs: unfinished jobs come back paused, finished ones are dropped.
    pub fn restore(jobs: Vec<TransferJob>) -> Queue {
        let jobs = jobs
            .into_iter()
            .filter(|j| !matches!(j.status, JobStatus::Done | JobStatus::Cancelled))
            .map(|mut j| {
                if matches!(
                    j.status,
                    JobStatus::Queued | JobStatus::Active | JobStatus::Waiting
                ) {
                    j.status = JobStatus::Paused;
                }
                j.wait_reason = None;
                j.next_retry_at = None;
                j.speed = 0.0;
                j
            })
            .collect();
        Queue { jobs }
    }

    pub fn enqueue(&mut self, jobs: Vec<TransferJob>) {
        self.jobs.extend(jobs);
    }

    pub fn startable(&self) -> Vec<String> {
        let active = self
            .jobs
            .iter()
            .filter(|j| j.status == JobStatus::Active)
            .count();
        self.jobs
            .iter()
            .filter(|j| j.status == JobStatus::Queued)
            .take(MAX_ACTIVE.saturating_sub(active))
            .map(|j| j.id.clone())
            .collect()
    }

    /// Queued → Active. False when the job was paused or cancelled meanwhile.
    pub fn mark_active(&mut self, id: &str) -> bool {
        let Some(j) = self.get_mut(id).filter(|j| j.status == JobStatus::Queued) else {
            return false;
        };
        j.status = JobStatus::Active;
        j.wait_reason = None;
        j.next_retry_at = None;
        true
    }

    /// Waiting for an unlock or a host: no attempt is used up.
    pub fn set_waiting(&mut self, id: &str, reason: WaitReason) {
        if let Some(j) = self.get_mut(id) {
            j.status = JobStatus::Waiting;
            j.wait_reason = Some(reason);
            j.speed = 0.0;
        }
    }

    /// Applies a finished run. `None` when the job is gone or no longer active (paused or
    /// cancelled meanwhile), so a late result never overwrites the user's choice.
    pub fn finish(
        &mut self,
        id: &str,
        result: Result<(), JobError>,
        now: i64,
    ) -> Option<&TransferJob> {
        // A run that published its file is done whatever arrived meanwhile (Pause, Resume,
        // Cancel): the file is in place. The caller checks it is still the job's current run.
        let published = result.is_ok();
        let j = self.jobs.iter_mut().find(|j| {
            j.id == id
                && if published {
                    j.status != JobStatus::Done
                } else {
                    j.status == JobStatus::Active
                }
        })?;
        j.speed = 0.0;
        match result {
            Ok(()) => {
                j.status = JobStatus::Done;
                j.transferred = j.src_size;
                j.error = None;
            }
            Err(JobError::Stopped) => j.status = JobStatus::Paused,
            Err(JobError::Operation(msg)) => {
                j.status = JobStatus::Failed;
                j.error = Some(msg);
            }
            Err(JobError::Connection(msg)) => {
                if j.attempt >= MAX_ATTEMPTS {
                    j.status = JobStatus::Failed;
                    j.error = Some(msg);
                } else {
                    j.attempt += 1;
                    j.status = JobStatus::Waiting;
                    j.wait_reason = Some(WaitReason::Retry);
                    j.next_retry_at = Some(now + retry_delay(j.attempt).as_millis() as i64);
                    j.error = Some(msg);
                }
            }
        }
        Some(j)
    }

    pub fn due(&mut self, now: i64) -> Vec<String> {
        let mut ids = Vec::new();
        for j in &mut self.jobs {
            if j.status == JobStatus::Waiting
                && j.wait_reason == Some(WaitReason::Retry)
                && j.next_retry_at.is_some_and(|t| t <= now)
            {
                j.status = JobStatus::Queued;
                j.wait_reason = None;
                j.next_retry_at = None;
                ids.push(j.id.clone());
            }
        }
        ids
    }

    pub fn pause(&mut self, id: &str) -> bool {
        self.transition(
            id,
            &[JobStatus::Queued, JobStatus::Active, JobStatus::Waiting],
            JobStatus::Paused,
        )
    }

    pub fn resume(&mut self, id: &str) -> bool {
        self.transition(id, &[JobStatus::Paused], JobStatus::Queued)
    }

    pub fn resume_all(&mut self) -> Vec<String> {
        let ids: Vec<String> = self
            .jobs
            .iter()
            .filter(|j| j.status == JobStatus::Paused)
            .map(|j| j.id.clone())
            .collect();
        for id in &ids {
            self.resume(id);
        }
        ids
    }

    pub fn retry(&mut self, id: &str) -> bool {
        self.transition(id, &[JobStatus::Failed], JobStatus::Queued)
    }

    pub fn cancel(&mut self, id: &str) -> Option<TransferJob> {
        let j = self
            .get_mut(id)
            .filter(|j| !matches!(j.status, JobStatus::Done | JobStatus::Cancelled))?;
        j.status = JobStatus::Cancelled;
        j.wait_reason = None;
        j.next_retry_at = None;
        j.speed = 0.0;
        Some(j.clone())
    }

    /// Removes done and cancelled rows, except those `keep` names (a live run still needs a
    /// cancelled row to clean up its `.part`).
    pub fn clear_finished(&mut self, keep: impl Fn(&str) -> bool) -> Vec<String> {
        let gone = |j: &TransferJob| {
            matches!(j.status, JobStatus::Done | JobStatus::Cancelled) && !keep(&j.id)
        };
        let removed = self
            .jobs
            .iter()
            .filter(|j| gone(j))
            .map(|j| j.id.clone())
            .collect();
        self.jobs.retain(|j| !gone(j));
        removed
    }

    pub fn forget_all(&mut self) {
        self.jobs.clear();
    }

    pub fn get(&self, id: &str) -> Option<&TransferJob> {
        self.jobs.iter().find(|j| j.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut TransferJob> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    pub fn all(&self) -> &[TransferJob] {
        &self.jobs
    }

    pub fn waiting_for(&self, reason: WaitReason) -> Vec<String> {
        self.jobs
            .iter()
            .filter(|j| j.status == JobStatus::Waiting && j.wait_reason == Some(reason))
            .map(|j| j.id.clone())
            .collect()
    }

    pub fn wake(&mut self, id: &str) -> bool {
        self.transition(id, &[JobStatus::Waiting], JobStatus::Queued)
    }

    /// Moves a job between statuses; resuming or retrying starts the attempt count afresh.
    fn transition(&mut self, id: &str, from: &[JobStatus], to: JobStatus) -> bool {
        let Some(j) = self.get_mut(id).filter(|j| from.contains(&j.status)) else {
            return false;
        };
        j.status = to;
        j.wait_reason = None;
        j.next_retry_at = None;
        j.speed = 0.0;
        if to == JobStatus::Queued && from != [JobStatus::Waiting] {
            j.attempt = 0;
            j.error = None;
        }
        true
    }
}

#[cfg(test)]
pub(crate) fn test_job(id: &str, status: JobStatus) -> TransferJob {
    TransferJob {
        id: id.into(),
        kind: JobKind::Download,
        src: Endpoint {
            path: "/r/a".into(),
            host: None,
        },
        dest: Endpoint {
            path: "/l/a".into(),
            host: None,
        },
        replace: false,
        part_path: part_path("/l/a", id),
        src_size: 100,
        src_mtime: 7,
        status,
        transferred: 0,
        attempt: 0,
        next_retry_at: None,
        wait_reason: None,
        error: None,
        created_at: 0,
        speed: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use JobStatus::*;

    fn q(jobs: &[(&str, JobStatus)]) -> Queue {
        let mut q = Queue::default();
        q.enqueue(jobs.iter().map(|(id, s)| test_job(id, *s)).collect());
        q
    }
    fn st(q: &Queue, id: &str) -> JobStatus {
        q.get(id).unwrap().status
    }

    #[test]
    fn mark_active_only_from_queued() {
        let mut q = q(&[("p", Paused), ("c", Cancelled), ("q", Queued)]);
        assert!(!q.mark_active("p"));
        assert!(!q.mark_active("c"));
        assert!(q.mark_active("q"));
        assert_eq!(
            (st(&q, "p"), st(&q, "c"), st(&q, "q")),
            (Paused, Cancelled, Active)
        );
    }

    #[test]
    fn startable_caps_active_and_ignores_waiting() {
        let q = q(&[
            ("a", Active),
            ("b", Active),
            ("w", Waiting),
            ("c", Queued),
            ("d", Queued),
            ("e", Queued),
        ]);
        assert_eq!(q.startable(), vec!["c".to_string()]);
    }

    #[test]
    fn connection_error_waits_with_backoff() {
        let mut q = q(&[("a", Active)]);
        q.finish("a", Err(JobError::Connection("reset".into())), 1000);
        let j = q.get("a").unwrap();
        assert_eq!(j.status, Waiting);
        assert_eq!(j.wait_reason, Some(WaitReason::Retry));
        assert_eq!(j.attempt, 1);
        assert_eq!(j.next_retry_at, Some(3000));
    }

    #[test]
    fn sixth_connection_error_fails() {
        let mut q = q(&[("a", Active)]);
        q.get_mut("a").unwrap().attempt = 5;
        q.finish("a", Err(JobError::Connection("reset".into())), 1000);
        let j = q.get("a").unwrap();
        assert_eq!(j.status, Failed);
        assert_eq!(j.error.as_deref(), Some("reset"));
    }

    #[test]
    fn operation_error_fails_at_once() {
        let mut q = q(&[("a", Active)]);
        q.finish("a", Err(JobError::Operation("denied".into())), 1000);
        let j = q.get("a").unwrap();
        assert_eq!(j.status, Failed);
        assert_eq!(j.error.as_deref(), Some("denied"));
        assert_eq!(j.attempt, 0);
    }

    #[test]
    fn due_requeues_only_elapsed_retries() {
        let mut q = q(&[("a", Active)]);
        q.finish("a", Err(JobError::Connection("x".into())), 1000);
        assert!(q.due(2999).is_empty());
        assert_eq!(q.due(3000), vec!["a".to_string()]);
        assert_eq!(st(&q, "a"), Queued);
        assert_eq!(q.get("a").unwrap().wait_reason, None);
    }

    #[test]
    fn finish_after_pause_keeps_paused() {
        let mut q = q(&[("a", Active)]);
        assert!(q.pause("a"));
        assert!(q.finish("a", Err(JobError::Stopped), 0).is_none());
        assert_eq!(st(&q, "a"), Paused);
    }

    #[test]
    fn pause_during_publish_still_ends_done() {
        // The file was already moved into place when Pause arrived: the job is done.
        let mut q = q(&[("a", Active)]);
        q.pause("a");
        let j = q.finish("a", Ok(()), 0).unwrap();
        assert_eq!(j.status, Done);
    }

    #[test]
    fn finish_after_cancel_keeps_cancelled() {
        let mut q = q(&[("a", Active)]);
        assert!(q.cancel("a").is_some());
        assert!(q.finish("a", Err(JobError::Stopped), 0).is_none());
        assert_eq!(st(&q, "a"), Cancelled);
    }

    #[test]
    fn a_published_file_is_done_whatever_came_meanwhile() {
        // The rename already landed the file: Cancel, or Pause then Resume, can't undo that.
        for interleave in ["cancel", "pause+resume"] {
            let mut q = q(&[("a", Active)]);
            if interleave == "cancel" {
                q.cancel("a");
            } else {
                q.pause("a");
                q.resume("a");
            }
            let j = q.finish("a", Ok(()), 0).unwrap();
            assert_eq!(j.status, Done, "after {interleave}");
        }
        let mut q = q(&[("a", Done)]);
        assert!(q.finish("a", Ok(()), 0).is_none(), "already done");
    }

    #[test]
    fn finish_unknown_job_is_noop() {
        let mut q = q(&[("a", Active)]);
        q.forget_all();
        assert!(q.finish("a", Ok(()), 0).is_none());
        assert!(q.all().is_empty());
    }

    #[test]
    fn finish_ok_is_done_with_full_size() {
        let mut q = q(&[("a", Active)]);
        let j = q.finish("a", Ok(()), 0).unwrap();
        assert_eq!((j.status, j.transferred), (Done, 100));
    }

    #[test]
    fn stopped_without_pause_becomes_paused() {
        let mut q = q(&[("a", Active)]);
        q.finish("a", Err(JobError::Stopped), 0);
        assert_eq!(st(&q, "a"), Paused);
    }

    #[test]
    fn resume_and_retry_reset_attempts() {
        let mut q = q(&[("p", Paused), ("f", Failed)]);
        for id in ["p", "f"] {
            let j = q.get_mut(id).unwrap();
            j.attempt = 3;
            j.error = Some("x".into());
        }
        assert!(q.resume("p"));
        assert!(q.retry("f"));
        for id in ["p", "f"] {
            let j = q.get(id).unwrap();
            assert_eq!((j.status, j.attempt, j.error.clone()), (Queued, 0, None));
        }
        assert!(!q.resume("f"), "resume only applies to paused");
    }

    #[test]
    fn restore_maps_statuses() {
        let mut waiting = test_job("w", Waiting);
        waiting.wait_reason = Some(WaitReason::Retry);
        waiting.next_retry_at = Some(5);
        let q = Queue::restore(vec![
            test_job("q", Queued),
            test_job("a", Active),
            waiting,
            test_job("f", Failed),
            test_job("d", Done),
            test_job("c", Cancelled),
            test_job("p", Paused),
        ]);
        let ids: Vec<_> = q.all().iter().map(|j| (j.id.as_str(), j.status)).collect();
        assert_eq!(
            ids,
            vec![
                ("q", Paused),
                ("a", Paused),
                ("w", Paused),
                ("f", Failed),
                ("p", Paused)
            ]
        );
        let w = q.get("w").unwrap();
        assert_eq!((w.wait_reason, w.next_retry_at), (None, None));
    }

    #[test]
    fn pause_frees_a_slot() {
        let mut q = q(&[("a", Active), ("b", Active), ("c", Active), ("d", Queued)]);
        assert!(q.startable().is_empty());
        q.pause("b");
        assert_eq!(q.startable(), vec!["d".to_string()]);
    }

    #[test]
    fn clear_finished_removes_done_and_cancelled_only() {
        let mut q = q(&[("d", Done), ("c", Cancelled), ("f", Failed), ("p", Paused)]);
        let mut removed = q.clear_finished(|_| false);
        removed.sort();
        assert_eq!(removed, vec!["c".to_string(), "d".to_string()]);
        assert_eq!(q.all().len(), 2);
    }

    #[test]
    fn clear_finished_keeps_rows_a_live_run_still_needs() {
        let mut q = q(&[("c", Cancelled), ("d", Done)]);
        let removed = q.clear_finished(|id| id == "c");
        assert_eq!(removed, vec!["d".to_string()]);
        assert_eq!(st(&q, "c"), Cancelled);
    }

    #[test]
    fn wait_and_wake_for_host() {
        let mut q = q(&[("a", Active)]);
        q.set_waiting("a", WaitReason::Host);
        assert_eq!(q.waiting_for(WaitReason::Host), vec!["a".to_string()]);
        assert_eq!(q.get("a").unwrap().attempt, 0);
        assert!(!q.startable().contains(&"a".to_string()));
        assert!(q.wake("a"));
        assert_eq!(st(&q, "a"), Queued);
    }
}
