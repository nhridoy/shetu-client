//! Watches each edit's temp folder and reports a file once it has been quiet for a second.
//! The folder, not the file, is watched: editors often save by writing a new file and renaming
//! it over the old one, which replaces the file being watched.

use notify::{PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

pub const QUIET: Duration = Duration::from_secs(1);

enum Cmd {
    Watch {
        id: String,
        dir: PathBuf,
        file: String,
    },
    Unwatch {
        id: String,
    },
}

pub struct Watching {
    watcher: RecommendedWatcher,
    /// Used for folders the OS watcher can't take (e.g. the inotify watch limit is used up).
    poll: Option<PollWatcher>,
    events: mpsc::UnboundedSender<PathBuf>,
    cmds: mpsc::UnboundedSender<Cmd>,
}

fn forward(
    events: mpsc::UnboundedSender<PathBuf>,
) -> impl Fn(notify::Result<notify::Event>) + Send + 'static {
    move |res| {
        if let Ok(event) = res {
            for path in event.paths {
                let _ = events.send(path);
            }
        }
    }
}

/// Which edit a reported path belongs to: `<edit_id>/<file name>` (the last two components),
/// so a symlinked or canonicalised prefix (e.g. macOS `/private/var`) still matches.
fn key(path: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?;
    let dir = path.parent()?.file_name()?.to_str()?;
    Some(format!("{dir}/{file}"))
}

/// Starts watching; `settled` receives an edit id after its file has been quiet for `QUIET`.
pub fn start(settled: mpsc::UnboundedSender<String>) -> notify::Result<Watching> {
    let (events_tx, mut events) = mpsc::unbounded_channel::<PathBuf>();
    let watcher = notify::recommended_watcher(forward(events_tx.clone()))?;
    let (cmds, mut cmd_rx) = mpsc::unbounded_channel::<Cmd>();
    tauri::async_runtime::spawn(async move {
        let mut files: HashMap<String, String> = HashMap::new(); // "<dir>/<file>" → edit id
        let mut due: HashMap<String, tokio::time::Instant> = HashMap::new();
        loop {
            let next = due.values().min().copied();
            let wake = async {
                match next {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                Some(path) = events.recv() => {
                    if let Some(id) = key(&path).and_then(|k| files.get(&k)) {
                        due.insert(id.clone(), tokio::time::Instant::now() + QUIET);
                    }
                }
                Some(cmd) = cmd_rx.recv() => match cmd {
                    Cmd::Watch { id, dir, file } => {
                        if let Some(k) = key(&dir.join(&file)) {
                            files.insert(k, id);
                        }
                    }
                    Cmd::Unwatch { id } => {
                        files.retain(|_, v| v != &id);
                        due.remove(&id);
                    }
                },
                _ = wake => {
                    let now = tokio::time::Instant::now();
                    let ready: Vec<String> =
                        due.iter().filter(|(_, at)| **at <= now).map(|(id, _)| id.clone()).collect();
                    for id in ready {
                        due.remove(&id);
                        if settled.send(id).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    Ok(Watching {
        watcher,
        poll: None,
        events: events_tx,
        cmds,
    })
}

impl Watching {
    pub fn watch(&mut self, id: &str, dir: &Path, file: &str) {
        if let Err(e) = self.watcher.watch(dir, RecursiveMode::NonRecursive) {
            log::warn!(
                "edits: OS watcher refused {} ({e}); polling it instead",
                dir.display()
            );
            let polled = match self.poll.as_mut() {
                Some(poll) => poll.watch(dir, RecursiveMode::NonRecursive),
                None => {
                    let config = notify::Config::default()
                        .with_poll_interval(Duration::from_millis(500))
                        // A same-size save within one tick barely moves the mtime: compare
                        // contents (only the few edit folders are polled).
                        .with_compare_contents(true);
                    PollWatcher::new(forward(self.events.clone()), config).and_then(|mut poll| {
                        let result = poll.watch(dir, RecursiveMode::NonRecursive);
                        self.poll = Some(poll);
                        result
                    })
                }
            };
            if let Err(e) = polled {
                log::warn!("edits: could not watch {}: {e}", dir.display());
            }
        }
        let _ = self.cmds.send(Cmd::Watch {
            id: id.into(),
            dir: dir.into(),
            file: file.into(),
        });
    }

    pub fn unwatch(&mut self, id: &str, dir: &Path) {
        let _ = self.watcher.unwatch(dir);
        if let Some(poll) = self.poll.as_mut() {
            let _ = poll.unwatch(dir);
        }
        let _ = self.cmds.send(Cmd::Unwatch { id: id.into() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rename_over_counts_as_a_save() {
        let root = std::env::temp_dir().join(format!("shetu-watch-{}", uuid::Uuid::new_v4()));
        let dir = root.join("e1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"v1").unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut watching = start(tx).unwrap();
        watching.watch("e1", &dir, "a.txt");
        tokio::time::sleep(Duration::from_millis(200)).await;
        // How editors save: write a temp file next to it, then rename it over the original.
        std::fs::write(dir.join(".a.txt.tmp"), b"v2").unwrap();
        std::fs::rename(dir.join(".a.txt.tmp"), dir.join("a.txt")).unwrap();
        // Unrelated files in the same folder (swap files) don't count.
        std::fs::write(dir.join(".a.txt.swp"), b"x").unwrap();
        let got = tokio::time::timeout(Duration::from_secs(4), rx.recv()).await;
        assert_eq!(got.unwrap().as_deref(), Some("e1"));
        let again = tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await;
        assert!(again.is_err(), "one burst of events, one report");
        watching.unwatch("e1", &dir);
        let _ = std::fs::remove_dir_all(&root);
    }
}
