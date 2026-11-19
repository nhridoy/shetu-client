//! Every decision about remote edits, one event at a time. Pure: the loop in `manager.rs`
//! feeds it (saves, job outcomes, user choices) and carries out the effects.

use crate::transfers::model::{HostRef, JobStatus, ABSENT, DEST_CHANGED};
use serde::{Deserialize, Serialize};

pub const LARGE_FILE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditStatus {
    Watching,
    Uploading,
    Conflict,
    /// Restored after a restart with changes that never reached the server; not watched.
    NotUploaded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Overwrite,
    KeepServer,
    SaveAsCopy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: String,
    pub session_id: String,
    pub host: HostRef,
    pub remote_path: String,
    pub local_path: String,
    /// The server copy's (size, mtime) this edit last knew.
    pub baseline: (u64, i64),
    /// The temp file's (size, mtime) as Shetu last saw or wrote it.
    pub last_local: (u64, i64),
    /// The latest save hasn't reached the server.
    pub unsent: bool,
    pub status: EditStatus,
    pub job: Option<String>,
    /// The local state being uploaded right now.
    pub uploading: Option<(u64, i64)>,
    /// Saved again while an upload was running: upload once more after it.
    pub dirty: bool,
    /// The current upload is a "Save mine as a copy".
    pub saving_copy: bool,
    pub conflict: Option<(u64, i64)>,
    pub error: Option<String>,
    /// Keep-server's download is running: it replaces the temp file, so Stop waits for it.
    #[serde(default)]
    pub downloading: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditEffect {
    Upload {
        edit_id: String,
        local_path: String,
        remote_path: String,
        replace: bool,
        expect: Option<(u64, i64)>,
    },
    /// KeepServer: copy the server file over the temp copy. `shown` is the server version the
    /// user chose to keep, restored as the conflict if the download fails.
    Download {
        edit_id: String,
        shown: (u64, i64),
    },
    /// Look up the server copy (after an upload was refused as a conflict).
    StatRemote {
        edit_id: String,
    },
    Conflict {
        edit_id: String,
        remote: (u64, i64),
    },
    /// Emit the list and save `edits.json`.
    Changed,
    Remove {
        edit_id: String,
        local_dir: String,
    },
}

#[derive(Debug, Default)]
pub struct EditState {
    edits: Vec<Edit>,
}

pub fn needs_confirm(size: u64, confirmed: bool) -> bool {
    size > LARGE_FILE && !confirmed
}

fn local_dir(local_path: &str) -> String {
    std::path::Path::new(local_path)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

impl EditState {
    pub fn list(&self) -> Vec<Edit> {
        self.edits.clone()
    }

    pub fn get(&self, id: &str) -> Option<&Edit> {
        self.edits.iter().find(|e| e.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Edit> {
        self.edits.iter_mut().find(|e| e.id == id)
    }

    pub fn find(&self, session_id: &str, remote_path: &str) -> Option<&Edit> {
        self.edits
            .iter()
            // A "Not uploaded" edit is never reused: reopening makes a fresh one.
            .find(|e| {
                e.session_id == session_id
                    && e.remote_path == remote_path
                    && e.status != EditStatus::NotUploaded
            })
    }

    pub fn opened(&mut self, edit: Edit) -> Vec<EditEffect> {
        self.edits.retain(|e| e.id != edit.id);
        self.edits.push(edit);
        vec![EditEffect::Changed]
    }

    /// Starts an upload of the temp file as it is now (`last_local`).
    fn upload(e: &mut Edit, replace: bool, expect: Option<(u64, i64)>) -> EditEffect {
        e.status = EditStatus::Uploading;
        e.uploading = Some(e.last_local);
        e.unsent = true;
        e.error = None;
        EditEffect::Upload {
            edit_id: e.id.clone(),
            local_path: e.local_path.clone(),
            remote_path: e.remote_path.clone(),
            replace,
            expect,
        }
    }

    pub fn saved(
        &mut self,
        id: &str,
        local: (u64, i64),
        remote: Option<(u64, i64)>,
    ) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        // Not watched (restored after a restart), or Shetu's own write / no real change.
        if e.status == EditStatus::NotUploaded || local == e.last_local {
            return Vec::new();
        }
        e.last_local = local;
        e.unsent = true;
        match e.status {
            // Wait for the user's answer, or for the running upload to finish.
            EditStatus::Conflict => vec![EditEffect::Changed],
            EditStatus::Uploading => {
                e.dirty = true;
                vec![EditEffect::Changed]
            }
            _ if remote == Some(e.baseline) => {
                let baseline = e.baseline;
                vec![Self::upload(e, true, Some(baseline)), EditEffect::Changed]
            }
            _ => {
                let remote = remote.unwrap_or(ABSENT);
                e.status = EditStatus::Conflict;
                e.conflict = Some(remote);
                vec![
                    EditEffect::Conflict {
                        edit_id: e.id.clone(),
                        remote,
                    },
                    EditEffect::Changed,
                ]
            }
        }
    }

    /// A save while the edit's connection is gone: kept as unsent with an error, never taken
    /// for a conflict.
    pub fn saved_offline(&mut self, id: &str, local: (u64, i64), message: &str) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        if e.status == EditStatus::NotUploaded || local == e.last_local {
            return Vec::new();
        }
        e.last_local = local;
        e.unsent = true;
        e.error = Some(message.to_string());
        vec![EditEffect::Changed]
    }

    /// Shows a problem on the edit (e.g. its file can't be watched).
    pub fn set_error(&mut self, id: &str, message: &str) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        e.error = Some(message.to_string());
        vec![EditEffect::Changed]
    }

    pub fn enqueued(&mut self, id: &str, job_id: String) {
        if let Some(e) = self.get_mut(id) {
            e.job = Some(job_id);
        }
    }

    pub fn job_finished(
        &mut self,
        job_id: &str,
        status: JobStatus,
        error: Option<String>,
        published: Option<(u64, i64)>,
    ) -> Vec<EditEffect> {
        let Some(e) = self
            .edits
            .iter_mut()
            .find(|e| e.job.as_deref() == Some(job_id))
        else {
            return Vec::new();
        };
        e.job = None;
        let uploaded = e.uploading.take();
        match status {
            JobStatus::Done => {
                let copy = std::mem::take(&mut e.saving_copy);
                e.dirty = false;
                e.status = EditStatus::Watching;
                e.error = None;
                e.conflict = None;
                // A copy went to "name (copy)": the server's own file still matches the
                // baseline, so the next save asks again. Otherwise the server now holds what was
                // published (read back by the queue, so a server that kept its own mtime still
                // matches).
                if !copy {
                    if let Some(now) = published.or(uploaded) {
                        e.baseline = now;
                    }
                }
                // Unsent whenever the temp file isn't what was uploaded: saves made during the
                // upload, online or not, are never lost.
                e.unsent = uploaded != Some(e.last_local);
                if e.unsent && !copy {
                    let baseline = e.baseline;
                    return vec![Self::upload(e, true, Some(baseline)), EditEffect::Changed];
                }
                vec![EditEffect::Changed]
            }
            JobStatus::Failed if error.as_deref() == Some(DEST_CHANGED) => {
                e.status = EditStatus::Conflict;
                e.saving_copy = false;
                vec![
                    EditEffect::StatRemote {
                        edit_id: e.id.clone(),
                    },
                    EditEffect::Changed,
                ]
            }
            _ => {
                e.status = EditStatus::Watching;
                e.saving_copy = false;
                e.error = error;
                vec![EditEffect::Changed]
            }
        }
    }

    pub fn conflict_found(&mut self, id: &str, remote: (u64, i64)) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        e.status = EditStatus::Conflict;
        e.conflict = Some(remote);
        e.unsent = true;
        vec![
            EditEffect::Conflict {
                edit_id: e.id.clone(),
                remote,
            },
            EditEffect::Changed,
        ]
    }

    /// Acts once per conflict: the first choice takes it, later clicks find none.
    pub fn resolve(&mut self, id: &str, choice: Choice) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        if e.status != EditStatus::Conflict {
            return Vec::new();
        }
        let Some(shown) = e.conflict.take() else {
            return Vec::new();
        };
        match choice {
            // Replaces only the server version the user was shown (or, if it was gone, only
            // while it still is): a newer one is refused and asks again.
            Choice::Overwrite => vec![Self::upload(e, true, Some(shown)), EditEffect::Changed],
            Choice::KeepServer => {
                e.downloading = true;
                vec![EditEffect::Download {
                    edit_id: e.id.clone(),
                    shown,
                }]
            }
            Choice::SaveAsCopy => {
                e.saving_copy = true;
                vec![Self::upload(e, false, None), EditEffect::Changed]
            }
        }
    }

    /// KeepServer's download failed: say why and ask again.
    pub fn download_failed(
        &mut self,
        id: &str,
        shown: (u64, i64),
        message: &str,
    ) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        e.downloading = false;
        e.conflict = Some(shown);
        e.error = Some(message.to_string());
        vec![EditEffect::Changed]
    }

    /// The server couldn't be asked after a refused upload: kept unsent with the reason, so
    /// Upload (which raises the conflict again) still works.
    pub fn conflict_check_failed(&mut self, id: &str, message: &str) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        if e.status == EditStatus::Conflict && e.conflict.is_none() {
            e.status = EditStatus::Watching;
        }
        e.unsent = true;
        e.error = Some(message.to_string());
        vec![EditEffect::Changed]
    }

    /// A save check that read the server before an upload landed: its reading is out of date.
    pub fn stale_check(&self, id: &str, seen_baseline: (u64, i64)) -> bool {
        self.get(id).is_some_and(|e| e.baseline != seen_baseline)
    }

    pub fn downloaded(
        &mut self,
        id: &str,
        local: (u64, i64),
        remote: (u64, i64),
    ) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        e.downloading = false;
        e.baseline = remote;
        e.last_local = local;
        e.unsent = false;
        e.dirty = false;
        e.conflict = None;
        e.error = None;
        e.status = EditStatus::Watching;
        vec![EditEffect::Changed]
    }

    pub fn upload_now(&mut self, id: &str) -> Vec<EditEffect> {
        let Some(e) = self.get_mut(id) else {
            return Vec::new();
        };
        // One upload at a time (the running one is followed by another if the file changed),
        // and none while a conflict waits for its answer.
        if matches!(e.status, EditStatus::Uploading | EditStatus::Conflict) {
            return Vec::new();
        }
        let baseline = e.baseline;
        vec![Self::upload(e, true, Some(baseline)), EditEffect::Changed]
    }

    /// `local_now` is the temp file on disk now: a save not seen yet still counts as unsent.
    pub fn stop(
        &mut self,
        id: &str,
        discard: bool,
        local_now: Option<(u64, i64)>,
    ) -> Result<Vec<EditEffect>, String> {
        let Some(e) = self.get(id) else {
            return Ok(Vec::new());
        };
        // A queued upload can't be taken back: it would publish after the edit is gone.
        if e.status == EditStatus::Uploading {
            return Err("Wait for the upload to finish, then stop".into());
        }
        if e.downloading {
            return Err("Wait for the server version to download, then stop".into());
        }
        // Unreadable counts too: an editor may be between moving the old file aside and
        // renaming the new one in.
        let unseen = local_now != Some(e.last_local);
        if (e.unsent || unseen) && !discard {
            return Err("unsent".into());
        }
        let local_dir = local_dir(&e.local_path);
        self.edits.retain(|e| e.id != id);
        Ok(vec![
            EditEffect::Remove {
                edit_id: id.to_string(),
                local_dir,
            },
            EditEffect::Changed,
        ])
    }

    /// `local_now` reads each temp file: one saved after the last check (e.g. just before quitting)
    /// is kept as unsent.
    pub fn restore(
        &mut self,
        saved: Vec<Edit>,
        local_now: impl Fn(&Edit) -> Option<(u64, i64)>,
    ) -> Vec<EditEffect> {
        let mut effects = Vec::new();
        for mut e in saved {
            // Changed, or unreadable (possibly mid-save): kept, never deleted unasked.
            let now = local_now(&e);
            if now != Some(e.last_local) {
                if let Some(now) = now {
                    e.last_local = now;
                }
                e.unsent = true;
            }
            if e.unsent {
                e.status = EditStatus::NotUploaded;
                e.job = None;
                e.uploading = None;
                e.dirty = false;
                e.saving_copy = false;
                e.downloading = false;
                self.edits.push(e);
            } else {
                effects.push(EditEffect::Remove {
                    local_dir: local_dir(&e.local_path),
                    edit_id: e.id,
                });
            }
        }
        effects.push(EditEffect::Changed);
        effects
    }

    pub fn wipe(&mut self) -> Vec<EditEffect> {
        let mut effects: Vec<EditEffect> = self
            .edits
            .drain(..)
            .map(|e| EditEffect::Remove {
                local_dir: local_dir(&e.local_path),
                edit_id: e.id,
            })
            .collect();
        effects.push(EditEffect::Changed);
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use EditEffect::*;

    const BASE: (u64, i64) = (10, 100);

    fn edit(id: &str) -> Edit {
        Edit {
            id: id.into(),
            session_id: "pane-1".into(),
            host: HostRef {
                host_id: Some("h1".into()),
                host: "web-01".into(),
                port: 22,
                username: "me".into(),
            },
            remote_path: "/etc/nginx.conf".into(),
            local_path: format!("/cache/remote-edits/{id}/nginx.conf"),
            baseline: BASE,
            last_local: BASE,
            unsent: false,
            status: EditStatus::Watching,
            job: None,
            uploading: None,
            dirty: false,
            saving_copy: false,
            conflict: None,
            error: None,
            downloading: false,
        }
    }

    fn opened() -> EditState {
        let mut s = EditState::default();
        s.opened(edit("e"));
        s
    }

    fn uploads(effects: &[EditEffect]) -> Vec<(bool, Option<(u64, i64)>)> {
        effects
            .iter()
            .filter_map(|e| match e {
                Upload {
                    replace, expect, ..
                } => Some((*replace, *expect)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn save_with_unchanged_server_uploads_expecting_the_baseline() {
        let mut s = opened();
        let fx = s.saved("e", (12, 200), Some(BASE));
        assert_eq!(uploads(&fx), vec![(true, Some(BASE))]);
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.uploading),
            (EditStatus::Uploading, true, Some((12, 200)))
        );
    }

    #[test]
    fn save_after_server_changed_asks_and_does_not_upload() {
        let mut s = opened();
        let fx = s.saved("e", (12, 200), Some((99, 300)));
        assert!(uploads(&fx).is_empty());
        assert!(fx.contains(&Conflict {
            edit_id: "e".into(),
            remote: (99, 300)
        }));
        assert_eq!(s.get("e").unwrap().status, EditStatus::Conflict);
        assert!(s.get("e").unwrap().unsent);
    }

    #[test]
    fn saves_while_conflict_pending_never_upload() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        let fx = s.saved("e", (13, 210), Some(BASE));
        assert!(uploads(&fx).is_empty());
        assert_eq!(s.get("e").unwrap().last_local, (13, 210));
    }

    #[test]
    fn own_download_is_not_a_save() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert!(s.resolve("e", Choice::KeepServer).contains(&Download {
            edit_id: "e".into(),
            shown: (99, 300)
        }));
        s.downloaded("e", (99, 301), (99, 300));
        assert!(s.saved("e", (99, 301), Some((99, 300))).is_empty());
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.baseline, e.unsent, e.status),
            ((99, 300), false, EditStatus::Watching)
        );
    }

    #[test]
    fn save_during_upload_uploads_again_after() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        assert!(uploads(&s.saved("e", (14, 220), Some(BASE))).is_empty());
        let fx = s.job_finished("job-1", JobStatus::Done, None, None);
        assert_eq!(uploads(&fx), vec![(true, Some((12, 200)))]);
        assert_eq!(s.get("e").unwrap().uploading, Some((14, 220)));
    }

    #[test]
    fn done_sets_baseline_to_uploaded_local_and_clears_unsent() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        s.job_finished("job-1", JobStatus::Done, None, None);
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.baseline, e.unsent, e.status, e.job.clone()),
            ((12, 200), false, EditStatus::Watching, None)
        );
    }

    #[test]
    fn dest_changed_failure_becomes_a_conflict() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        let fx = s.job_finished("job-1", JobStatus::Failed, Some(DEST_CHANGED.into()), None);
        assert!(fx.contains(&StatRemote {
            edit_id: "e".into()
        }));
        let fx = s.conflict_found("e", (99, 300));
        assert!(fx.contains(&Conflict {
            edit_id: "e".into(),
            remote: (99, 300)
        }));
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.baseline),
            (EditStatus::Conflict, true, BASE)
        );
    }

    #[test]
    fn other_failure_keeps_unsent() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        s.job_finished("job-1", JobStatus::Failed, Some("disk full".into()), None);
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.error.as_deref()),
            (EditStatus::Watching, true, Some("disk full"))
        );
        assert_eq!(uploads(&s.upload_now("e")), vec![(true, Some(BASE))]);
    }

    #[test]
    fn save_as_copy_keeps_baseline_and_next_save_conflicts() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert_eq!(
            uploads(&s.resolve("e", Choice::SaveAsCopy)),
            vec![(false, None)]
        );
        s.enqueued("e", "job-1".into());
        s.job_finished("job-1", JobStatus::Done, None, None);
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.baseline, e.unsent, e.status),
            (BASE, false, EditStatus::Watching)
        );
        let fx = s.saved("e", (13, 210), Some((99, 300)));
        assert!(fx.iter().any(|f| matches!(f, Conflict { .. })));
    }

    #[test]
    fn stop_with_unsent_needs_discard() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert_eq!(s.stop("e", false, None), Err("unsent".to_string()));
        let fx = s.stop("e", true, None).unwrap();
        assert!(fx.contains(&Remove {
            edit_id: "e".into(),
            local_dir: "/cache/remote-edits/e".into()
        }));
        assert!(s.list().is_empty());
        let mut s = opened();
        assert!(
            s.stop("e", false, Some(BASE)).is_ok(),
            "nothing unsent: stops without asking"
        );
    }

    #[test]
    fn restore_keeps_unsent_and_forgets_job() {
        let mut s = EditState::default();
        let mut unsent = edit("u");
        unsent.unsent = true;
        unsent.status = EditStatus::Uploading;
        unsent.job = Some("job-9".into());
        unsent.dirty = true;
        let fx = s.restore(vec![unsent, edit("sent")], |_| Some(BASE));
        assert!(fx.contains(&Remove {
            edit_id: "sent".into(),
            local_dir: "/cache/remote-edits/sent".into()
        }));
        let list = s.list();
        assert_eq!(list.len(), 1);
        let u = &list[0];
        assert_eq!(
            (u.status, u.job.clone(), u.dirty, u.unsent),
            (EditStatus::NotUploaded, None, false, true)
        );
        assert!(
            s.saved("u", (50, 500), Some(BASE)).is_empty(),
            "not watched until reopened"
        );
    }

    #[test]
    fn wipe_removes_everything() {
        let mut s = opened();
        s.opened(edit("f"));
        let fx = s.wipe();
        assert_eq!(fx.iter().filter(|f| matches!(f, Remove { .. })).count(), 2);
        assert!(s.list().is_empty());
    }

    #[test]
    fn a_save_without_a_connection_is_unsent_not_a_conflict() {
        let mut s = opened();
        let fx = s.saved_offline(
            "e",
            (12, 200),
            "Connection closed — reopen the pane, then Upload",
        );
        assert!(!fx
            .iter()
            .any(|f| matches!(f, Conflict { .. } | Upload { .. })));
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.last_local),
            (EditStatus::Watching, true, (12, 200))
        );
        assert!(e.error.as_deref().unwrap().contains("Connection closed"));
    }

    #[test]
    fn done_uses_the_published_state_as_baseline() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        // The server kept its own mtime (no setstat): the baseline must be what is there.
        s.job_finished("job-1", JobStatus::Done, None, Some((12, 999)));
        assert_eq!(s.get("e").unwrap().baseline, (12, 999));
        let fx = s.saved("e", (13, 210), Some((12, 999)));
        assert_eq!(
            uploads(&fx),
            vec![(true, Some((12, 999)))],
            "no false conflict"
        );
    }

    #[test]
    fn offline_save_during_upload_stays_unsent_and_uploads_again() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        s.saved_offline("e", (14, 220), "offline");
        let fx = s.job_finished("job-1", JobStatus::Done, None, Some((12, 200)));
        assert_eq!(uploads(&fx), vec![(true, Some((12, 200)))]);
        assert!(s.get("e").unwrap().unsent);
    }

    #[test]
    fn save_during_save_as_copy_stays_unsent() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        s.resolve("e", Choice::SaveAsCopy);
        s.enqueued("e", "job-1".into());
        s.saved("e", (14, 220), Some((99, 300)));
        let fx = s.job_finished("job-1", JobStatus::Done, None, Some((12, 200)));
        assert!(
            uploads(&fx).is_empty(),
            "the server copy still differs: no silent overwrite"
        );
        let e = s.get("e").unwrap();
        assert!(e.unsent);
        assert_eq!(e.baseline, BASE);
        assert!(s.stop("e", false, None).is_err(), "Stop still asks");
    }

    #[test]
    fn upload_now_while_uploading_waits_for_the_running_one() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        assert!(uploads(&s.upload_now("e")).is_empty());
        assert_eq!(s.get("e").unwrap().job.as_deref(), Some("job-1"));
    }

    #[test]
    fn a_conflict_is_resolved_once() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert_eq!(uploads(&s.resolve("e", Choice::Overwrite)).len(), 1);
        assert!(
            s.resolve("e", Choice::KeepServer).is_empty(),
            "second click does nothing"
        );
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert!(!s.resolve("e", Choice::KeepServer).is_empty());
        assert!(s.resolve("e", Choice::Overwrite).is_empty());
    }

    #[test]
    fn overwrite_replaces_only_the_server_version_shown() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert_eq!(
            uploads(&s.resolve("e", Choice::Overwrite)),
            vec![(true, Some((99, 300)))]
        );
        // The server file was gone when asked: it must still be gone.
        let mut s = opened();
        s.saved("e", (12, 200), None);
        assert_eq!(
            uploads(&s.resolve("e", Choice::Overwrite)),
            vec![(true, Some(ABSENT))]
        );
    }

    #[test]
    fn failed_keep_server_reports_and_still_asks() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        s.resolve("e", Choice::KeepServer);
        s.download_failed("e", (99, 300), "Connection closed");
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.conflict, e.unsent, e.error.as_deref()),
            (
                EditStatus::Conflict,
                Some((99, 300)),
                true,
                Some("Connection closed")
            )
        );
        assert!(
            !s.resolve("e", Choice::KeepServer).is_empty(),
            "can choose again"
        );
    }

    #[test]
    fn a_conflict_check_that_cannot_reach_the_server_stays_actionable() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        s.job_finished("job-1", JobStatus::Failed, Some(DEST_CHANGED.into()), None);
        s.conflict_check_failed("e", "Connection closed");
        let e = s.get("e").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.error.as_deref()),
            (EditStatus::Watching, true, Some("Connection closed"))
        );
        assert_eq!(uploads(&s.upload_now("e")), vec![(true, Some(BASE))]);
    }

    #[test]
    fn stop_checks_the_file_on_disk() {
        let mut s = opened();
        assert_eq!(
            s.stop("e", false, Some((12, 200))),
            Err("unsent".to_string()),
            "saved but not seen yet"
        );
        assert!(s.stop("e", false, Some(BASE)).is_ok());
    }

    #[test]
    fn stop_waits_for_a_running_upload() {
        let mut s = opened();
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        assert!(
            s.stop("e", true, Some((12, 200))).is_err(),
            "even with Discard"
        );
        assert!(s.get("e").is_some());
    }

    #[test]
    fn restore_keeps_a_sent_edit_changed_on_disk() {
        let mut s = EditState::default();
        let fx = s.restore(vec![edit("changed"), edit("same")], |e| {
            Some(if e.id == "changed" { (12, 200) } else { BASE })
        });
        assert!(fx.contains(&Remove {
            edit_id: "same".into(),
            local_dir: "/cache/remote-edits/same".into()
        }));
        let e = s.get("changed").unwrap();
        assert_eq!(
            (e.status, e.unsent, e.last_local),
            (EditStatus::NotUploaded, true, (12, 200))
        );
    }

    #[test]
    fn a_save_check_from_before_an_upload_landed_is_stale() {
        let mut s = opened();
        assert!(!s.stale_check("e", BASE));
        s.saved("e", (12, 200), Some(BASE));
        s.enqueued("e", "job-1".into());
        s.job_finished("job-1", JobStatus::Done, None, Some((12, 200)));
        assert!(
            s.stale_check("e", BASE),
            "server read before the upload: look again"
        );
        assert!(!s.stale_check("e", (12, 200)));
    }

    #[test]
    fn upload_now_waits_for_the_conflict_answer() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        assert!(s.upload_now("e").is_empty());
        s.resolve("e", Choice::KeepServer);
        assert!(
            s.upload_now("e").is_empty(),
            "nor while Keep-server downloads"
        );
    }

    #[test]
    fn an_unreadable_temp_file_is_not_safe_to_delete() {
        let mut s = opened();
        assert_eq!(s.stop("e", false, None), Err("unsent".to_string()));
        let mut s = EditState::default();
        let fx = s.restore(vec![edit("gone")], |_| None);
        assert!(!fx.iter().any(|f| matches!(f, Remove { .. })));
        assert_eq!(s.get("gone").unwrap().status, EditStatus::NotUploaded);
    }

    #[test]
    fn stop_waits_for_a_keep_server_download() {
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        s.resolve("e", Choice::KeepServer);
        assert!(
            s.stop("e", true, Some((12, 200))).is_err(),
            "even with Discard"
        );
        s.downloaded("e", (99, 301), (99, 300));
        assert!(s.stop("e", false, Some((99, 301))).is_ok());
        let mut s = opened();
        s.saved("e", (12, 200), Some((99, 300)));
        s.resolve("e", Choice::KeepServer);
        s.download_failed("e", (99, 300), "offline");
        assert!(s.stop("e", true, Some((12, 200))).is_ok());
    }

    #[test]
    fn find_prefers_the_active_edit_of_a_file() {
        let mut s = EditState::default();
        let mut old = edit("old");
        old.unsent = true;
        s.restore(vec![old], |_| Some(BASE));
        assert!(
            s.find("pane-1", "/etc/nginx.conf").is_none(),
            "Not uploaded isn't reused"
        );
        s.opened(edit("new"));
        assert_eq!(s.find("pane-1", "/etc/nginx.conf").unwrap().id, "new");
    }

    #[test]
    fn over_50mb_needs_confirmation() {
        assert!(!needs_confirm(LARGE_FILE, false));
        assert!(needs_confirm(LARGE_FILE + 1, false));
        assert!(!needs_confirm(LARGE_FILE + 1, true));
    }
}
