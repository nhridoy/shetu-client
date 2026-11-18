//! Tauri glue for remote edits: one loop owns `EditState` and the watcher; commands and
//! background work (stats, downloads, uploads) talk to it by message.

use super::files::{
    create_edit_dir, inside_root, load_edits, save_edits, sweep_targets, watch_target,
};
use super::state::{needs_confirm, Choice, Edit, EditEffect, EditState, EditStatus};
use super::watch::{self, Watching};
use crate::transfers::io::{self, Side};
use crate::transfers::manager::{build_job, JobFinished, NewJob, TransferManager};
use crate::transfers::model::{HostRef, JobError, JobKind, JobStatus};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub const CHANGED_EVENT: &str = "edits://changed";
pub const CONFLICT_EVENT: &str = "edits://conflict";
const STABLE_GAP: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictView {
    id: String,
    file_name: String,
    host: String,
    remote_path: String,
}

enum Msg {
    Find {
        session_id: String,
        remote_path: String,
        reply: oneshot::Sender<Option<Edit>>,
    },
    Opened(Box<Edit>),
    List(oneshot::Sender<Vec<Edit>>),
    Get {
        id: String,
        reply: oneshot::Sender<Option<Edit>>,
    },
    Stop {
        id: String,
        discard: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resolve {
        id: String,
        choice: Choice,
        remote_now: (u64, i64),
    },
    UploadNow(String),
    Wipe(oneshot::Sender<()>),
    /// The watcher saw the file go quiet.
    Settled(String),
    Saved {
        id: String,
        local: (u64, i64),
        remote: Option<(u64, i64)>,
    },
    SavedOffline {
        id: String,
        local: (u64, i64),
    },
    EnqueueFailed {
        job_id: String,
        error: String,
    },
    Finished(JobFinished),
    RemoteStat {
        id: String,
        remote: (u64, i64),
    },
    Downloaded {
        id: String,
        local: (u64, i64),
        remote: (u64, i64),
    },
}

/// Queued uploads from an earlier run whose source is one of our temp copies: their edits come
/// back as "Not uploaded" (the user re-uploads), so these must not run on their own.
pub fn stale_edit_uploads(
    jobs: &[crate::transfers::model::TransferJob],
    root: &Path,
) -> Vec<String> {
    jobs.iter()
        .filter(|j| j.kind == JobKind::Upload && j.src.host.is_none())
        .filter(|j| !matches!(j.status, JobStatus::Done | JobStatus::Cancelled))
        .filter(|j| Path::new(&j.src.path).starts_with(root))
        .map(|j| j.id.clone())
        .collect()
}

/// Watches an edit's temp file; if that's impossible, the edit says so (saves won't upload).
fn start_watching(watching: &mut Watching, state: &mut EditState, edit: &Edit) -> Vec<EditEffect> {
    let watched =
        watch_target(edit).is_some_and(|(dir, file)| watching.watch(&edit.id, &dir, &file));
    if watched {
        Vec::new()
    } else {
        state.set_error(
            &edit.id,
            "Can't watch this file — saves won't upload; use Upload",
        )
    }
}

#[derive(Clone)]
pub struct EditManager {
    tx: mpsc::UnboundedSender<Msg>,
    root: PathBuf,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// The SFTP handle for an edit: its own pane's session first, else any open one to that host.
fn session_for(
    app: &tauri::AppHandle,
    host: &HostRef,
    session_id: &str,
) -> Option<Arc<SftpSession>> {
    app.state::<crate::sftp::SftpSessions>()
        .find_matching(host, Some(session_id))
        .map(|(_, _, sftp)| sftp)
}

async fn local_stat(path: &str) -> Result<(u64, i64), String> {
    io::stat(&Side::Local, path).await.map_err(err_text)
}

fn err_text(e: JobError) -> String {
    match e {
        JobError::Connection(m) | JobError::Operation(m) => m,
        JobError::Stopped => "stopped".into(),
    }
}

/// Copies the server file over `local_path` (through a `.part`, then a rename).
async fn download(
    sftp: Arc<SftpSession>,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let part = format!("{local_path}.part");
    io::copy(
        &Side::Sftp(sftp),
        remote_path,
        &Side::Local,
        &part,
        0,
        &CancellationToken::new(),
        |_| {},
    )
    .await
    .map_err(err_text)?;
    tokio::fs::rename(&part, local_path)
        .await
        .map_err(|e| e.to_string())
}

impl EditManager {
    /// Restores unsent edits from the last run and starts the loop.
    pub fn new(app: tauri::AppHandle) -> EditManager {
        let root = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("remote-edits");
        let (tx, rx) = mpsc::unbounded_channel();
        let finished = app.state::<TransferManager>().subscribe_finished();
        tauri::async_runtime::spawn(run_loop(app, root.clone(), rx, tx.clone(), finished));
        EditManager { tx, root }
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> Result<T, String> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(msg(reply))
            .map_err(|_| "Editing stopped".to_string())?;
        answer.await.map_err(|_| "Editing stopped".to_string())
    }

    /// Sign-out / device wipe: stop every edit and delete every temp copy, unsent included.
    pub async fn wipe(&self) {
        let _ = self.ask(Msg::Wipe).await;
    }
}

async fn run_loop(
    app: tauri::AppHandle,
    root: PathBuf,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    tx: mpsc::UnboundedSender<Msg>,
    mut finished: mpsc::UnboundedReceiver<JobFinished>,
) {
    let mut state = EditState::default();
    let (settled_tx, mut settled) = mpsc::unbounded_channel();
    let mut watching = watch::start(settled_tx);

    // Unsent edits survive a restart (listed as Not uploaded); everything else is cleaned up.
    // If the list can't be read, nothing is deleted: unsent work may be in those folders.
    let loaded = load_edits(&root);
    if let Err(e) = &loaded {
        log::warn!("edits: could not read the saved list: {e}");
    }
    let mut effects = state.restore(loaded.clone().unwrap_or_default());
    let keep: Vec<String> = state.list().into_iter().map(|e| e.id).collect();
    for dir in sweep_targets(&root, loaded.is_ok().then_some(keep.as_slice())) {
        let _ = std::fs::remove_dir_all(dir);
    }
    // Watched again, so that once uploaded (or reopened) their saves upload as usual.
    for edit in state.list() {
        effects.extend(start_watching(&mut watching, &mut state, &edit));
    }
    apply(&app, &root, &tx, &mut state, &mut watching, effects);
    // Uploads of these temp copies left in the queue by the last run would race the restored
    // "Not uploaded" edits (and a later Upload): cancel them; the user re-uploads.
    let transfers = app.state::<TransferManager>().inner().clone();
    let edits_root = root.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(jobs) = transfers.list().await {
            for id in stale_edit_uploads(&jobs, &edits_root) {
                transfers.cancel(id);
            }
        }
    });

    loop {
        let msg = tokio::select! {
            Some(msg) = rx.recv() => msg,
            Some(id) = settled.recv() => Msg::Settled(id),
            Some(done) = finished.recv() => Msg::Finished(done),
            else => break,
        };
        let effects = match msg {
            Msg::Find {
                session_id,
                remote_path,
                reply,
            } => {
                let _ = reply.send(state.find(&session_id, &remote_path).cloned());
                Vec::new()
            }
            Msg::Opened(edit) => {
                let edit = *edit;
                let mut effects = state.opened(edit.clone());
                effects.extend(start_watching(&mut watching, &mut state, &edit));
                effects
            }
            Msg::List(reply) => {
                let _ = reply.send(state.list());
                Vec::new()
            }
            Msg::Get { id, reply } => {
                let _ = reply.send(state.get(&id).cloned());
                Vec::new()
            }
            Msg::Stop { id, discard, reply } => match state.stop(&id, discard) {
                Ok(effects) => {
                    let _ = reply.send(Ok(()));
                    effects
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                    Vec::new()
                }
            },
            Msg::Resolve {
                id,
                choice,
                remote_now,
            } => state.resolve(&id, choice, remote_now),
            Msg::UploadNow(id) => state.upload_now(&id),
            Msg::Wipe(reply) => {
                let effects = state.wipe();
                apply(&app, &root, &tx, &mut state, &mut watching, effects);
                let _ = std::fs::remove_dir_all(&root);
                let _ = reply.send(());
                Vec::new()
            }
            Msg::Settled(id) => {
                if let Some(edit) = state.get(&id).cloned() {
                    tauri::async_runtime::spawn(check_save(app.clone(), tx.clone(), edit));
                }
                Vec::new()
            }
            Msg::Saved { id, local, remote } => state.saved(&id, local, remote),
            Msg::SavedOffline { id, local } => state.saved_offline(&id, local),
            Msg::EnqueueFailed { job_id, error } => {
                state.job_finished(&job_id, JobStatus::Failed, Some(error), None)
            }
            Msg::Finished(done) => {
                state.job_finished(&done.id, done.status, done.error, done.published)
            }
            Msg::RemoteStat { id, remote } => state.conflict_found(&id, remote),
            Msg::Downloaded { id, local, remote } => state.downloaded(&id, local, remote),
        };
        apply(&app, &root, &tx, &mut state, &mut watching, effects);
    }
}

/// After a quiet second: wait until the temp file stops changing, then look at the server copy.
async fn check_save(app: tauri::AppHandle, tx: mpsc::UnboundedSender<Msg>, edit: Edit) {
    let mut local = match local_stat(&edit.local_path).await {
        Ok(stat) => stat,
        Err(_) => return,
    };
    // An editor may still be writing: act only on a size and time that hold for a moment.
    for _ in 0..8 {
        tokio::time::sleep(STABLE_GAP).await;
        let Ok(again) = local_stat(&edit.local_path).await else {
            return;
        };
        if again == local {
            break;
        }
        local = again;
    }
    let Some(sftp) = session_for(&app, &edit.host, &edit.session_id) else {
        let _ = tx.send(Msg::SavedOffline { id: edit.id, local });
        return;
    };
    let remote = match io::stat(&Side::Sftp(sftp), &edit.remote_path).await {
        Ok(stat) => Some(stat),
        Err(JobError::Operation(_)) => None,
        Err(_) => {
            let _ = tx.send(Msg::SavedOffline { id: edit.id, local });
            return;
        }
    };
    let _ = tx.send(Msg::Saved {
        id: edit.id,
        local,
        remote,
    });
}

fn apply(
    app: &tauri::AppHandle,
    root: &Path,
    tx: &mpsc::UnboundedSender<Msg>,
    state: &mut EditState,
    watching: &mut Watching,
    effects: Vec<EditEffect>,
) {
    for effect in effects {
        match effect {
            EditEffect::Changed => {
                let list = state.list();
                if let Err(e) = save_edits(root, &list) {
                    log::warn!("edits: could not save the list: {e}");
                }
                let _ = app.emit(CHANGED_EVENT, &list);
            }
            EditEffect::Conflict { edit_id, .. } => {
                if let Some(e) = state.get(&edit_id) {
                    let view = ConflictView {
                        id: e.id.clone(),
                        file_name: file_name(&e.remote_path),
                        host: e.host.host.clone(),
                        remote_path: e.remote_path.clone(),
                    };
                    let _ = app.emit(CONFLICT_EVENT, view);
                }
            }
            EditEffect::Upload {
                edit_id,
                local_path,
                remote_path,
                replace,
                expect,
            } => {
                let Some(host) = state.get(&edit_id).map(|e| e.host.clone()) else {
                    continue;
                };
                // The job id is fixed here, inside the loop, so the edit knows its job before
                // the queue can possibly report it finished.
                let job_id = uuid::Uuid::new_v4().to_string();
                state.enqueued(&edit_id, job_id.clone());
                let (app, tx) = (app.clone(), tx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let snapshot = local_stat(&local_path).await?;
                        let new = NewJob {
                            kind: JobKind::Upload,
                            src_path: local_path,
                            dest_path: remote_path,
                            src_session_id: None,
                            dest_session_id: None,
                            replace,
                        };
                        let mut job = build_job(&new, None, Some(host), snapshot, now_ms());
                        job.part_path = crate::transfers::model::part_path(&job.dest.path, &job_id);
                        job.id = job_id.clone();
                        job.expect_dest = expect;
                        let queued = app
                            .state::<TransferManager>()
                            .enqueue_built(vec![job])
                            .await?;
                        queued
                            .first()
                            .map(|_| ())
                            .ok_or_else(|| "nothing queued".to_string())
                    }
                    .await;
                    if let Err(error) = result {
                        let _ = tx.send(Msg::EnqueueFailed { job_id, error });
                    }
                });
            }
            EditEffect::Download { edit_id } => {
                let Some(edit) = state.get(&edit_id).cloned() else {
                    continue;
                };
                let (app, tx) = (app.clone(), tx.clone());
                tauri::async_runtime::spawn(async move {
                    let Some(sftp) = session_for(&app, &edit.host, &edit.session_id) else {
                        return;
                    };
                    // The server state is read before downloading: a change made meanwhile then
                    // shows up as a conflict on the next save instead of being overwritten.
                    let Ok(remote) =
                        io::stat(&Side::Sftp(Arc::clone(&sftp)), &edit.remote_path).await
                    else {
                        return;
                    };
                    if download(sftp, &edit.remote_path, &edit.local_path)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let Ok(local) = local_stat(&edit.local_path).await else {
                        return;
                    };
                    let _ = tx.send(Msg::Downloaded {
                        id: edit.id,
                        local,
                        remote,
                    });
                });
            }
            EditEffect::StatRemote { edit_id } => {
                let Some(edit) = state.get(&edit_id).cloned() else {
                    continue;
                };
                let (app, tx) = (app.clone(), tx.clone());
                tauri::async_runtime::spawn(async move {
                    let Some(sftp) = session_for(&app, &edit.host, &edit.session_id) else {
                        return;
                    };
                    let remote = io::stat(&Side::Sftp(sftp), &edit.remote_path)
                        .await
                        .unwrap_or((0, 0));
                    let _ = tx.send(Msg::RemoteStat {
                        id: edit.id,
                        remote,
                    });
                });
            }
            EditEffect::Remove { edit_id, local_dir } => {
                watching.unwatch(&edit_id, Path::new(&local_dir));
                if inside_root(root, Path::new(&local_dir)) {
                    let _ = std::fs::remove_dir_all(&local_dir);
                }
            }
        }
    }
}

type Mgr<'a> = tauri::State<'a, EditManager>;

#[tauri::command]
pub async fn edit_open(
    session_id: String,
    remote_path: String,
    app_name: Option<String>,
    confirm_large: bool,
    manager: Mgr<'_>,
    app: tauri::AppHandle,
) -> Result<Edit, String> {
    let open = |path: &str| {
        app.opener()
            .open_path(path, app_name.as_deref())
            .map_err(|e| format!("Couldn't open the file: {e}"))
    };
    // Already editing this file from this pane: open the same copy again.
    let existing = manager
        .ask(|reply| Msg::Find {
            session_id: session_id.clone(),
            remote_path: remote_path.clone(),
            reply,
        })
        .await?;
    if let Some(edit) = existing.filter(|e| e.status != EditStatus::NotUploaded) {
        open(&edit.local_path)?;
        return Ok(edit);
    }
    let (host, sftp) = app
        .state::<crate::sftp::SftpSessions>()
        .session_info(&session_id)
        .ok_or("SFTP session not found")?;
    let remote = io::stat(&Side::Sftp(Arc::clone(&sftp)), &remote_path)
        .await
        .map_err(err_text)?;
    if needs_confirm(remote.0, confirm_large) {
        return Err(format!("large:{}", remote.0));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = create_edit_dir(&manager.root, &id).map_err(|e| e.to_string())?;
    let local_path = dir.join(file_name(&remote_path)).display().to_string();
    if let Err(e) = download(sftp, &remote_path, &local_path).await {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    let local = local_stat(&local_path).await?;
    let edit = Edit {
        id,
        session_id,
        host,
        remote_path,
        local_path: local_path.clone(),
        baseline: remote,
        last_local: local,
        unsent: false,
        status: EditStatus::Watching,
        job: None,
        uploading: None,
        dirty: false,
        saving_copy: false,
        conflict: None,
        error: None,
    };
    manager
        .tx
        .send(Msg::Opened(Box::new(edit.clone())))
        .map_err(|_| "Editing stopped".to_string())?;
    open(&local_path)?;
    Ok(edit)
}

#[tauri::command]
pub async fn edit_list(manager: Mgr<'_>) -> Result<Vec<Edit>, String> {
    manager.ask(Msg::List).await
}

#[tauri::command]
pub async fn edit_stop(id: String, discard: bool, manager: Mgr<'_>) -> Result<(), String> {
    manager
        .ask(|reply| Msg::Stop { id, discard, reply })
        .await?
}

#[tauri::command]
pub async fn edit_resolve(
    id: String,
    choice: Choice,
    manager: Mgr<'_>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let edit = manager
        .ask(|reply| Msg::Get {
            id: id.clone(),
            reply,
        })
        .await?
        .ok_or("No such edit")?;
    // Overwrite must expect what the server holds now, so a change made after this still asks.
    let remote_now = match choice {
        Choice::Overwrite => {
            let sftp = session_for(&app, &edit.host, &edit.session_id)
                .ok_or("Connection closed — reopen the pane")?;
            io::stat(&Side::Sftp(sftp), &edit.remote_path)
                .await
                .map_err(err_text)?
        }
        _ => edit.baseline,
    };
    manager
        .tx
        .send(Msg::Resolve {
            id,
            choice,
            remote_now,
        })
        .map_err(|_| "Editing stopped".to_string())
}

#[tauri::command]
pub fn edit_upload_now(id: String, manager: Mgr<'_>) -> Result<(), String> {
    manager
        .tx
        .send(Msg::UploadNow(id))
        .map_err(|_| "Editing stopped".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfers::queue::test_job;

    #[test]
    fn stale_edit_uploads_are_unfinished_uploads_of_temp_copies() {
        let root = Path::new("/cache/remote-edits");
        let upload = |id: &str, src: &str, status: JobStatus| {
            let mut j = test_job(id, status);
            j.kind = JobKind::Upload;
            j.src.path = src.into();
            j.src.host = None;
            j
        };
        let jobs = vec![
            upload("a", "/cache/remote-edits/e1/nginx.conf", JobStatus::Paused),
            upload("b", "/cache/remote-edits/e2/x.conf", JobStatus::Done),
            upload("c", "/home/me/site/index.html", JobStatus::Paused),
            upload("d", "/cache/remote-edits/e3/y.conf", JobStatus::Failed),
        ];
        assert_eq!(
            stale_edit_uploads(&jobs, root),
            vec!["a".to_string(), "d".to_string()]
        );
    }
}
