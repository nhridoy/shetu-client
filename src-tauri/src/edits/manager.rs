//! Tauri glue for remote edits: one loop owns `EditState` and the watcher; commands and
//! background work (stats, downloads, uploads) talk to it by message.

use super::files::{
    create_edit_dir, inside_root, load_for_startup, local_file_name, remove_root, save_edits,
    sweep_targets, watch_target,
};
use super::state::{needs_confirm, Choice, Edit, EditEffect, EditState, EditStatus};
use super::watch::{self, Watching};
use crate::transfers::io::{self, Side};
use crate::transfers::manager::{build_job, JobFinished, NewJob, TransferManager};
use crate::transfers::model::{HostRef, JobError, JobKind, JobStatus, ABSENT};
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
    /// Also answers how many sign-out wipes have run, so an open can tell if one ran meanwhile,
    /// and the token a wipe cancels, which stops its download.
    Find {
        session_id: String,
        remote_path: String,
        reply: oneshot::Sender<(Option<Edit>, u64, CancellationToken)>,
    },
    /// Answered once the file is watched, so the editor opens only after that. Refused (and
    /// its copy deleted) if a wipe ran since the open started (`started`).
    /// Makes the open's temp folder (see `create_for_open`).
    CreateDir {
        id: String,
        started: u64,
        reply: oneshot::Sender<Result<PathBuf, String>>,
    },
    Opened {
        edit: Box<Edit>,
        started: u64,
        reply: oneshot::Sender<Result<(), String>>,
    },
    List(oneshot::Sender<Vec<Edit>>),
    Stop {
        id: String,
        discard: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resolve {
        id: String,
        choice: Choice,
    },
    UploadNow(String),
    Wipe(oneshot::Sender<Result<(), String>>),
    /// The watcher saw the file go quiet.
    Settled(String),
    Saved {
        id: String,
        local: (u64, i64),
        remote: Option<(u64, i64)>,
        /// The edit's baseline when the server was read.
        seen: (u64, i64),
    },
    SavedOffline {
        id: String,
        local: (u64, i64),
        error: String,
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
    DownloadFailed {
        id: String,
        shown: (u64, i64),
        error: String,
    },
    ConflictCheckFailed {
        id: String,
        error: String,
    },
}

const NO_CONNECTION: &str = "Connection closed — reopen the pane";

/// Queued uploads from an earlier run (created before `started_ms`) whose source is one of our
/// temp copies: their edits come back as "Not uploaded" (the user re-uploads), so these must not
/// run on their own. Uploads queued in this run are left alone.
pub fn stale_edit_uploads(
    jobs: &[crate::transfers::model::TransferJob],
    root: &Path,
    started_ms: i64,
) -> Vec<String> {
    jobs.iter()
        .filter(|j| j.created_at < started_ms)
        .filter(|j| j.kind == JobKind::Upload && j.src.host.is_none())
        .filter(|j| !matches!(j.status, JobStatus::Done | JobStatus::Cancelled))
        .filter(|j| Path::new(&j.src.path).starts_with(root))
        .map(|j| j.id.clone())
        .collect()
}

/// Makes an open's temp folder, unless a sign-out wipe ran since the open started. Done by the
/// loop, so no folder appears after a wipe; a wipe during the download deletes it.
fn create_for_open(root: &Path, id: &str, started: u64, wipes: u64) -> Result<PathBuf, String> {
    if started != wipes {
        return Err("Signed out while the file was opening".into());
    }
    create_edit_dir(root, id).map_err(|e| e.to_string())
}

fn drop_open_dir(root: &Path, edit: &Edit) -> Result<(), String> {
    match Path::new(&edit.local_path).parent() {
        Some(dir) if inside_root(root, dir) => {
            std::fs::remove_dir_all(dir).map_err(|e| format!("its copy couldn't be deleted ({e})"))
        }
        _ => Ok(()),
    }
}

/// Adds a just-downloaded edit, once it is saved in the list (or a restart would sweep its
/// folder). Refused, with its copy deleted, if a sign-out wipe ran meanwhile or saving fails.
fn register_open(
    state: &mut EditState,
    watching: &mut Watching,
    root: &Path,
    edit: Edit,
    started: u64,
    wipes: u64,
) -> Result<Vec<EditEffect>, String> {
    let refuse = |why: String| match drop_open_dir(root, &edit) {
        Ok(()) => Err(why),
        Err(e) => Err(format!("{why}; {e}")),
    };
    if started != wipes {
        return refuse("Signed out while the file was opening".into());
    }
    let mut effects = state.opened(edit.clone());
    if let Err(e) = save_edits(root, &state.list()) {
        let _ = state.stop(&edit.id, true, None);
        return refuse(format!("Couldn't save the list of edits: {e}"));
    }
    effects.extend(start_watching(watching, state, &edit));
    Ok(effects)
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

/// The temp file on disk now, read in place (the loop must not wait); same form as `io::stat`.
fn local_now(path: &str) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    Some((m.len(), mtime))
}

/// The file's size and time once they hold across one `gap`, trying `tries` times; None while
/// it is still being written (the watcher reports it again once it goes quiet) or unreadable.
async fn settled_stat(path: &str, gap: Duration, tries: u32) -> Option<(u64, i64)> {
    let mut last = local_stat(path).await.ok()?;
    for _ in 0..tries {
        tokio::time::sleep(gap).await;
        let again = local_stat(path).await.ok()?;
        if again == last {
            return Some(again);
        }
        last = again;
    }
    None
}

fn err_text(e: JobError) -> String {
    match e {
        JobError::Connection(m) | JobError::Operation(m) => m,
        JobError::Stopped => "stopped".into(),
    }
}

/// Copies the server file over `local_path` (through a `.part`, then a rename) and returns
/// the copy's (size, mtime), read before the rename: once it is in place there is nothing left
/// to fail.
async fn download(
    src: &Side,
    remote_path: &str,
    local_path: &str,
    stop: &CancellationToken,
) -> Result<(u64, i64), String> {
    let part = format!("{local_path}.part");
    io::copy(src, remote_path, &Side::Local, &part, 0, stop, |_| {})
        .await
        .map_err(err_text)?;
    let stat = local_stat(&part).await?;
    tokio::fs::rename(&part, local_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(stat)
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
        tauri::async_runtime::spawn(run_loop(app, root, rx, tx.clone(), finished));
        EditManager { tx }
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> Result<T, String> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(msg(reply))
            .map_err(|_| "Editing stopped".to_string())?;
        answer.await.map_err(|_| "Editing stopped".to_string())
    }

    /// Sign-out / device wipe: stop every edit and delete every temp copy, unsent included.
    pub async fn wipe(&self) -> Result<(), String> {
        self.ask(Msg::Wipe).await?
    }
}

async fn run_loop(
    app: tauri::AppHandle,
    root: PathBuf,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    tx: mpsc::UnboundedSender<Msg>,
    mut finished: mpsc::UnboundedReceiver<JobFinished>,
) {
    let started_ms = now_ms();
    let mut wipes: u64 = 0;
    // Cancelled by a wipe: downloads still running stop writing their (deleted) copies.
    let mut downloads = CancellationToken::new();
    let mut state = EditState::default();
    let (settled_tx, mut settled) = mpsc::unbounded_channel();
    let mut watching = watch::start(settled_tx);

    // Unsent edits survive a restart (listed as Not uploaded), and so do ones changed on disk
    // since they were last seen; everything else is cleaned up. If the list can't be read,
    // nothing is deleted: unsent work may be in those folders.
    let (loaded, may_sweep) = load_for_startup(&root);
    let mut effects = state.restore(loaded, |e| local_now(&e.local_path));
    let keep: Vec<String> = state.list().into_iter().map(|e| e.id).collect();
    for dir in sweep_targets(&root, may_sweep.then_some(keep.as_slice())) {
        let _ = std::fs::remove_dir_all(dir);
    }
    // Watched again, so that once uploaded (or reopened) their saves upload as usual.
    for edit in state.list() {
        effects.extend(start_watching(&mut watching, &mut state, &edit));
    }
    apply(
        &app,
        &root,
        &tx,
        &mut state,
        &mut watching,
        &downloads,
        effects,
    );
    // Uploads of these temp copies left in the queue by the last run would race the restored
    // "Not uploaded" edits (and a later Upload): cancel them; the user re-uploads.
    let transfers = app.state::<TransferManager>().inner().clone();
    let edits_root = root.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(jobs) = transfers.list().await {
            for id in stale_edit_uploads(&jobs, &edits_root, started_ms) {
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
                let found = state.find(&session_id, &remote_path).cloned();
                let _ = reply.send((found, wipes, downloads.clone()));
                Vec::new()
            }
            Msg::CreateDir { id, started, reply } => {
                let _ = reply.send(create_for_open(&root, &id, started, wipes));
                Vec::new()
            }
            Msg::Opened {
                edit,
                started,
                reply,
            } => match register_open(&mut state, &mut watching, &root, *edit, started, wipes) {
                Ok(effects) => {
                    let _ = reply.send(Ok(()));
                    effects
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                    Vec::new()
                }
            },
            Msg::List(reply) => {
                let _ = reply.send(state.list());
                Vec::new()
            }
            Msg::Stop { id, discard, reply } => {
                let on_disk = state.get(&id).and_then(|e| local_now(&e.local_path));
                match state.stop(&id, discard, on_disk) {
                    Ok(effects) => {
                        let _ = reply.send(Ok(()));
                        effects
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        Vec::new()
                    }
                }
            }
            Msg::Resolve { id, choice } => state.resolve(&id, choice),
            Msg::UploadNow(id) => state.upload_now(&id),
            Msg::Wipe(reply) => {
                wipes += 1;
                downloads.cancel();
                downloads = CancellationToken::new();
                let effects = state.wipe();
                apply(
                    &app,
                    &root,
                    &tx,
                    &mut state,
                    &mut watching,
                    &downloads,
                    effects,
                );
                let _ = reply.send(remove_root(&root));
                Vec::new()
            }
            Msg::Settled(id) => {
                if let Some(edit) = state.get(&id).cloned() {
                    tauri::async_runtime::spawn(check_save(app.clone(), tx.clone(), edit));
                }
                Vec::new()
            }
            // The server was read before an upload landed: read it again.
            Msg::Saved { id, seen, .. } if state.stale_check(&id, seen) => {
                if let Some(edit) = state.get(&id).cloned() {
                    tauri::async_runtime::spawn(check_save(app.clone(), tx.clone(), edit));
                }
                Vec::new()
            }
            Msg::Saved {
                id, local, remote, ..
            } => state.saved(&id, local, remote),
            Msg::SavedOffline { id, local, error } => state.saved_offline(&id, local, &error),
            Msg::EnqueueFailed { job_id, error } => {
                state.job_finished(&job_id, JobStatus::Failed, Some(error), None)
            }
            Msg::Finished(done) => {
                state.job_finished(&done.id, done.status, done.error, done.published)
            }
            Msg::RemoteStat { id, remote } => state.conflict_found(&id, remote),
            Msg::Downloaded { id, local, remote } => state.downloaded(&id, local, remote),
            Msg::DownloadFailed { id, shown, error } => state.download_failed(&id, shown, &error),
            Msg::ConflictCheckFailed { id, error } => state.conflict_check_failed(&id, &error),
        };
        apply(
            &app,
            &root,
            &tx,
            &mut state,
            &mut watching,
            &downloads,
            effects,
        );
    }
}

/// After a quiet second: wait until the temp file stops changing, then look at the server copy.
async fn check_save(app: tauri::AppHandle, tx: mpsc::UnboundedSender<Msg>, edit: Edit) {
    // An editor may still be writing: act only on a size and time that hold for a moment.
    let Some(local) = settled_stat(&edit.local_path, STABLE_GAP, 8).await else {
        return;
    };
    let Some(sftp) = session_for(&app, &edit.host, &edit.session_id) else {
        let _ = tx.send(Msg::SavedOffline {
            id: edit.id,
            local,
            error: format!("{NO_CONNECTION}, then Upload"),
        });
        return;
    };
    // Missing is a real answer (the save raises a conflict); a failed check keeps the save
    // unsent with the reason.
    let remote = match io::stat_if_exists(&Side::Sftp(sftp), &edit.remote_path).await {
        Ok(remote) => remote,
        Err(e) => {
            let _ = tx.send(Msg::SavedOffline {
                id: edit.id,
                local,
                error: format!(
                    "Couldn't check the server copy ({}) — use Upload",
                    err_text(e)
                ),
            });
            return;
        }
    };
    let _ = tx.send(Msg::Saved {
        id: edit.id,
        local,
        remote,
        seen: edit.baseline,
    });
}

fn apply(
    app: &tauri::AppHandle,
    root: &Path,
    tx: &mpsc::UnboundedSender<Msg>,
    state: &mut EditState,
    watching: &mut Watching,
    downloads: &CancellationToken,
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
            EditEffect::Download { edit_id, shown } => {
                let Some(edit) = state.get(&edit_id).cloned() else {
                    continue;
                };
                let (app, tx, stop) = (app.clone(), tx.clone(), downloads.clone());
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let sftp = session_for(&app, &edit.host, &edit.session_id)
                            .ok_or(NO_CONNECTION.to_string())?;
                        // The server state is read before downloading: a change made meanwhile
                        // then shows up as a conflict on the next save instead of being lost.
                        let remote = io::stat(&Side::Sftp(Arc::clone(&sftp)), &edit.remote_path)
                            .await
                            .map_err(err_text)?;
                        let local = download(
                            &Side::Sftp(sftp),
                            &edit.remote_path,
                            &edit.local_path,
                            &stop,
                        )
                        .await?;
                        Ok::<_, String>((local, remote))
                    }
                    .await;
                    let _ = tx.send(match result {
                        Ok((local, remote)) => Msg::Downloaded {
                            id: edit.id,
                            local,
                            remote,
                        },
                        Err(error) => Msg::DownloadFailed {
                            id: edit.id,
                            shown,
                            error: format!("Couldn't get the server version: {error}"),
                        },
                    });
                });
            }
            EditEffect::StatRemote { edit_id } => {
                let Some(edit) = state.get(&edit_id).cloned() else {
                    continue;
                };
                let (app, tx) = (app.clone(), tx.clone());
                tauri::async_runtime::spawn(async move {
                    let msg = match session_for(&app, &edit.host, &edit.session_id) {
                        None => Err(NO_CONNECTION.to_string()),
                        // Gone from the server is ABSENT, as for a save.
                        Some(sftp) => io::stat_if_exists(&Side::Sftp(sftp), &edit.remote_path)
                            .await
                            .map(|r| r.unwrap_or(ABSENT))
                            .map_err(err_text),
                    };
                    let _ = tx.send(match msg {
                        Ok(remote) => Msg::RemoteStat {
                            id: edit.id,
                            remote,
                        },
                        Err(error) => Msg::ConflictCheckFailed {
                            id: edit.id,
                            error: format!("Upload refused and the server couldn't be checked ({error}) — try Upload again"),
                        },
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
    let (existing, started, downloads) = manager
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
    let dir = manager
        .ask(|reply| Msg::CreateDir {
            id: id.clone(),
            started,
            reply,
        })
        .await??;
    let local_path = dir
        .join(local_file_name(&remote_path))
        .display()
        .to_string();
    let local = match download(&Side::Sftp(sftp), &remote_path, &local_path, &downloads).await {
        Ok(local) => local,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
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
        downloading: false,
    };
    // Watched before the editor opens: a save made right away isn't missed.
    manager
        .ask(|reply| Msg::Opened {
            edit: Box::new(edit.clone()),
            started,
            reply,
        })
        .await??;
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
pub fn edit_resolve(id: String, choice: Choice, manager: Mgr<'_>) -> Result<(), String> {
    manager
        .tx
        .send(Msg::Resolve { id, choice })
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
            stale_edit_uploads(&jobs, root, i64::MAX),
            vec!["a".to_string(), "d".to_string()]
        );
    }

    #[test]
    fn uploads_queued_this_run_are_not_stale() {
        let mut j = test_job("new", JobStatus::Queued);
        j.kind = JobKind::Upload;
        j.src.path = "/cache/remote-edits/e1/nginx.conf".into();
        j.src.host = None;
        j.created_at = 2_000;
        let root = Path::new("/cache/remote-edits");
        assert!(stale_edit_uploads(std::slice::from_ref(&j), root, 1_000).is_empty());
        assert_eq!(
            stale_edit_uploads(&[j], root, 3_000),
            vec!["new".to_string()]
        );
    }

    fn test_edit(dir: &Path) -> Edit {
        Edit {
            id: "e1".into(),
            session_id: "pane-1".into(),
            host: HostRef {
                host_id: Some("h1".into()),
                host: "web-01".into(),
                port: 22,
                username: "me".into(),
            },
            remote_path: "/srv/a.txt".into(),
            local_path: dir.join("a.txt").display().to_string(),
            baseline: (6, 100),
            last_local: (6, 100),
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

    #[tokio::test]
    async fn an_open_that_outlived_a_sign_out_is_dropped() {
        let root = std::env::temp_dir().join(format!("shetu-reg-{}", uuid::Uuid::new_v4()));
        let dir = create_edit_dir(&root, "e1").unwrap();
        std::fs::write(dir.join("a.txt"), b"secret").unwrap();
        let edit = test_edit(&dir);
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut watching = watch::start(tx);
        let mut state = EditState::default();
        let late = register_open(&mut state, &mut watching, &root, edit.clone(), 0, 1);
        assert!(late.is_err());
        assert!(!dir.exists(), "the copy made after sign-out is deleted");
        assert!(state.list().is_empty());
        let dir = create_edit_dir(&root, "e1").unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert!(register_open(&mut state, &mut watching, &root, edit, 1, 1).is_ok());
        assert_eq!(state.list().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_open_that_cannot_be_saved_is_refused() {
        let root = std::env::temp_dir().join(format!("shetu-reg-{}", uuid::Uuid::new_v4()));
        let dir = create_for_open(&root, "e2", 0, 0).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        // The list's temp file can't be written: the edit wouldn't survive a restart.
        std::fs::create_dir_all(root.join("edits.json.tmp")).unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut watching = watch::start(tx);
        let mut state = EditState::default();
        let mut edit = test_edit(&dir);
        edit.id = "e2".into();
        assert!(register_open(&mut state, &mut watching, &root, edit, 0, 0).is_err());
        assert!(state.list().is_empty());
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_edit_folder_is_made_after_a_sign_out() {
        let root = std::env::temp_dir().join(format!("shetu-mk-{}", uuid::Uuid::new_v4()));
        assert!(create_for_open(&root, "e3", 0, 1).is_err());
        assert!(!root.exists());
        assert!(create_for_open(&root, "e3", 1, 1).unwrap().exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_sign_out_stops_a_download_in_flight() {
        let dir = std::env::temp_dir().join(format!("shetu-dlc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (src, dst) = (dir.join("server.txt"), dir.join("local.txt"));
        std::fs::write(&src, vec![b'x'; 1 << 20]).unwrap();
        let stop = CancellationToken::new();
        stop.cancel();
        let got = download(
            &Side::Local,
            &src.display().to_string(),
            &dst.display().to_string(),
            &stop,
        )
        .await;
        assert!(got.is_err());
        assert!(!dst.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_wipe_stops_a_download_that_is_running() {
        let dir = std::env::temp_dir().join(format!("shetu-dlr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A pipe as the "server file": it sends some bytes, then stalls mid-download.
        let (src, dst) = (dir.join("server.fifo"), dir.join("local.txt"));
        let made = std::process::Command::new("mkfifo")
            .arg(&src)
            .status()
            .unwrap();
        assert!(made.success());
        let feeder = {
            let src = src.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let mut pipe = std::fs::OpenOptions::new().write(true).open(&src).unwrap();
                pipe.write_all(&[b'x'; 4096]).unwrap();
                std::thread::sleep(Duration::from_secs(2));
            })
        };
        // The token the loop's wipe cancels.
        let downloads = CancellationToken::new();
        let running = {
            let (src, dst, stop) = (
                src.display().to_string(),
                dst.display().to_string(),
                downloads.clone(),
            );
            tokio::spawn(async move { download(&Side::Local, &src, &dst, &stop).await })
        };
        let part = dir.join("local.txt.part");
        tokio::time::timeout(Duration::from_secs(5), async {
            while std::fs::metadata(&part).map_or(0, |m| m.len()) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the download is under way");
        downloads.cancel();
        let got = tokio::time::timeout(Duration::from_secs(1), running)
            .await
            .expect("cancelling stops it at once")
            .unwrap();
        assert!(got.is_err());
        assert!(!dst.exists(), "nothing is put in place");
        feeder.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn download_reports_the_copy_it_put_in_place() {
        let dir = std::env::temp_dir().join(format!("shetu-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (src, dst) = (dir.join("server.txt"), dir.join("local.txt"));
        std::fs::write(&src, b"server copy").unwrap();
        let got = download(
            &Side::Local,
            &src.display().to_string(),
            &dst.display().to_string(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(got, (11, local_mtime(&dst)));
        assert_eq!(std::fs::read(&dst).unwrap(), b"server copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_still_being_written_is_not_settled() {
        let dir = std::env::temp_dir().join(format!("shetu-stable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.txt");
        std::fs::write(&path, b"x").unwrap();
        let p = path.display().to_string();
        assert_eq!(
            settled_stat(&p, Duration::from_millis(20), 3).await,
            Some((1, local_mtime(&path)))
        );
        // An editor that keeps saving: each version is swapped in whole (never seen half
        // written) and is a different size, on its own thread so test scheduling can't pause it.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (path, stop) = (path.clone(), Arc::clone(&stop));
            std::thread::spawn(move || {
                let tmp = path.with_extension("tmp");
                let mut size = 2;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    std::fs::write(&tmp, vec![b'y'; size]).unwrap();
                    std::fs::rename(&tmp, &path).unwrap();
                    size += 1;
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
        };
        assert_eq!(settled_stat(&p, Duration::from_millis(20), 3).await, None);
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn local_mtime(path: &Path) -> i64 {
        std::fs::metadata(path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }
}
