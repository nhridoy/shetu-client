use std::path::Path;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

pub const GIT_TIMEOUT_MS: u64 = 30_000;
const GIT_CHANGE_CAP: usize = 10_000;
/// Network operations (pull/push) can legitimately take minutes on large
/// repositories or slow connections.
const GIT_NETWORK_TIMEOUT_MS: u64 = 300_000;

/// Serializes all git operations so concurrent UI actions can never corrupt
/// the index or race reads against writes.
pub struct GitLock(pub std::sync::Arc<Mutex<()>>);

#[derive(serde::Serialize, Clone)]
pub struct GitChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub untracked: bool,
    /// True when the file is in an unmerged state (merge/rebase conflict).
    pub conflict: bool,
}

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    /// Upstream tracking branch, e.g. `origin/main`. `None` when the branch
    /// has no upstream configured.
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub changes: Vec<GitChange>,
    pub truncated: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct GitStash {
    pub reference: String,
    pub subject: String,
}

#[derive(serde::Serialize, Clone)]
pub struct GitCommit {
    /// Full 40-char hash.
    pub hash: String,
    /// Short hash, e.g. `f622c12`.
    pub short: String,
    /// One-line subject.
    pub subject: String,
    /// Author name.
    pub author: String,
    /// Author date, unix seconds.
    pub date: i64,
    /// Ref decorations, e.g. `HEAD -> ai, origin/ai` (may be empty).
    pub refs: String,
}

#[derive(serde::Serialize, Clone)]
pub struct GitBranch {
    /// Display name, e.g. `main` or `origin/main`
    pub name: String,
    /// Full refname, e.g. `refs/heads/main` or `refs/remotes/origin/main`
    pub refname: String,
    pub remote: bool,
    pub current: bool,
}

fn git_candidates() -> Vec<std::ffi::OsString> {
    let mut candidates: Vec<std::ffi::OsString> = vec![
        "git".into(),
        r"C:\Program Files\Git\cmd\git.exe".into(),
        r"C:\Program Files\Git\bin\git.exe".into(),
        r"C:\Program Files (x86)\Git\cmd\git.exe".into(),
        r"C:\Program Files (x86)\Git\bin\git.exe".into(),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            Path::new(&local)
                .join(r"Programs\Git\cmd\git.exe")
                .into(),
        );
    }
    candidates
}

/// Resolve a working git executable: PATH first, then common Windows install
/// locations. The result is cached for the lifetime of the process.
fn resolve_git() -> String {
    static GIT: OnceLock<String> = OnceLock::new();
    GIT.get_or_init(|| {
        for candidate in git_candidates() {
            if let Ok(out) = Command::new(&candidate).arg("--version").output() {
                if out.status.success() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
        "git".to_string()
    })
    .clone()
}

fn run_git(root: &str, args: &[&str]) -> Result<Output, String> {
    run_git_timeout(root, args, GIT_TIMEOUT_MS)
}

fn run_git_timeout(
    root: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<Output, String> {
    let git = resolve_git();
    let mut cmd = Command::new(&git);
    cmd.arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Never prompt for credentials from the UI
        .env("GIT_TERMINAL_PROMPT", "0")
        // Stable, English error strings regardless of the user's locale
        .env("LC_ALL", "C")
        .env("LANG", "C");

    let read_only = match args.first().map(|a| a.as_ref()) {
        Some("status") | Some("rev-parse") | Some("rev-list") | Some("show") => true,
        Some("log") => true,
        Some("ls-files") => true,
        // `git branch -a` lists branches; `git branch -d` deletes
        Some("branch") => args.contains(&"-a"),
        // `git stash list` is read-only; push/pop/apply/drop are writes
        Some("stash") => args.contains(&"list"),
        _ => false,
    };
    if read_only {
        // Avoid lock contention with other git processes on status/rev-parse
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }

    let child = cmd.spawn().map_err(|e| {
        format!("Failed to run git ({git}): {e} — is Git installed and on PATH?")
    })?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let output = child
            .wait_with_output()
            .unwrap_or_else(|_| Output {
                status: ExitStatus::default(),
                stdout: Vec::new(),
                stderr: Vec::new(),
            });
        let _ = tx.send(output);
    });

    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(output) => Ok(output),
        Err(_) => {
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
            drop(waiter);
            Err(format!(
                "git command timed out after {}ms",
                timeout_ms / 1000
            ))
        }
    }
}

fn require_success(out: &Output, what: &str) -> Result<(), String> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        stderr
    };
    let code = out
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());
    Err(if detail.is_empty() {
        format!("{what} failed (exit {code})")
    } else {
        format!("{what} failed (exit {code}): {detail}")
    })
}

fn branch_name(root: &str) -> Option<String> {
    let out = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

fn ahead_behind(root: &str) -> (i32, i32) {
    let out = match run_git(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) {
        Ok(out) => out,
        Err(_) => return (0, 0),
    };
    if !out.status.success() {
        return (0, 0);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn upstream_name(root: &str) -> Option<String> {
    let out = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "@{upstream}" {
        None
    } else {
        Some(name)
    }
}

fn parse_status(data: &str) -> (Vec<GitChange>, bool) {
    let fields: Vec<&str> = data.split('\0').filter(|s| !s.is_empty()).collect();
    let mut changes = Vec::new();
    let mut i = 0;
    while i < fields.len() && changes.len() < GIT_CHANGE_CAP {
        let entry = fields[i];
        if entry.len() >= 4 {
            let xy = &entry[..2];
            let path = entry[3..].to_string();
            let index_status = xy.as_bytes()[0] as char;
            let worktree_status = xy.as_bytes()[1] as char;
            let staged = index_status != ' ' && index_status != '?';
            let untracked = index_status == '?' && worktree_status == '?';
            // Unmerged states: UU, AA, DD, AU, UA, DU, UD
            let conflict = (index_status == 'U' || worktree_status == 'U')
                || (index_status == 'A' && worktree_status == 'A')
                || (index_status == 'D' && worktree_status == 'D');
            // Rename/copy entries carry the original path in the next field
            if index_status == 'R' || index_status == 'C' {
                i += 1;
            }
            changes.push(GitChange {
                path,
                index_status: index_status.to_string(),
                worktree_status: worktree_status.to_string(),
                staged,
                untracked,
                conflict,
            });
        }
        i += 1;
    }
    (changes, i < fields.len())
}

fn status_inner(root: &str) -> Result<GitStatus, String> {
    let out = run_git(root, &["status", "--porcelain=v1", "-z"])?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git status failed".to_string()
        } else {
            stderr
        });
    }
    let data = String::from_utf8_lossy(&out.stdout).into_owned();
    let (ahead, behind) = ahead_behind(root);
    let (changes, truncated) = parse_status(&data);
    Ok(GitStatus {
        branch: branch_name(root),
        upstream: upstream_name(root),
        ahead,
        behind,
        changes,
        truncated,
    })
}

#[tauri::command]
pub async fn git_status(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<GitStatus, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        status_inner(&root)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stage(
    root: String,
    path: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["add", "--", &path])?;
        require_success(&out, "Stage")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stage_all(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["add", "-A"])?;
        require_success(&out, "Stage all")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_unstage(
    root: String,
    path: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["restore", "--staged", "--", &path])?;
        require_success(&out, "Unstage")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_unstage_all(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["reset"])?;
        require_success(&out, "Unstage all")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Discard all changes for a path — both staged and worktree. Untracked
/// files are not supported (they have nothing to restore from).
#[tauri::command]
pub async fn git_discard(
    root: String,
    path: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["restore", "--staged", "--worktree", "--", &path])?;
        require_success(&out, "Discard changes")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_commit(
    root: String,
    message: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".to_string());
    }
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["commit", "-m", &message])?;
        require_success(&out, "Commit")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

fn parse_branches(data: &str) -> Vec<GitBranch> {
    let mut branches = Vec::new();
    for line in data.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\0');
        let head = parts.next().unwrap_or("");
        let refname = parts.next().unwrap_or("");
        let (name, remote) = if let Some(local) = refname.strip_prefix("refs/remotes/") {
            (local.to_string(), true)
        } else if let Some(local) = refname.strip_prefix("refs/heads/") {
            (local.to_string(), false)
        } else {
            continue;
        };
        branches.push(GitBranch {
            name,
            refname: refname.to_string(),
            remote,
            current: head == "*",
        });
    }
    branches
}

fn branches_inner(root: &str) -> Result<Vec<GitBranch>, String> {
    let out = run_git(
        root,
        &["branch", "-a", "--no-color", "--format=%(HEAD)%00%(refname)"],
    )?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git branch failed".to_string()
        } else {
            stderr
        });
    }
    let data = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(parse_branches(&data))
}

/// Reject branch names that could inject git options or are invalid refs.
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Branch name is empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name cannot start with '-'".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("'{name}' is not a valid branch name"));
    }
    if name
        .bytes()
        .any(|b| b < 0x20 || b == b' ' || b == 0x7f)
    {
        return Err("Branch name cannot contain whitespace".to_string());
    }
    for bad in ['~', '^', ':', '?', '*', '[', '\\', '\u{7f}'] {
        if name.contains(bad) {
            return Err(format!("'{bad}' is not allowed in a branch name"));
        }
    }
    Ok(())
}

/// Switch to a branch by full refname. Remote branches are checked out into a
/// new local branch tracking the remote one (never detached HEAD).
#[tauri::command]
pub async fn git_switch_branch(
    root: String,
    refname: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    if !refname.starts_with("refs/heads/") && !refname.starts_with("refs/remotes/") {
        return Err(format!("Invalid branch refname: {refname}"));
    }
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = if let Some(remote) = refname.strip_prefix("refs/remotes/") {
            let local = remote
                .rsplit('/')
                .next()
                .unwrap_or(remote)
                .to_string();
            run_git(
                &root,
                &["switch", "-c", &local, "--track", &refname],
            )?
        } else {
            // `git switch` takes a branch name, not a full refname
            // (only `git checkout` accepts `refs/heads/...`).
            let local = refname
                .strip_prefix("refs/heads/")
                .unwrap_or(&refname)
                .to_string();
            run_git(&root, &["switch", &local])?
        };
        require_success(&out, "Switch branch")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Create a branch from the current HEAD and switch to it.
#[tauri::command]
pub async fn git_create_branch(
    root: String,
    name: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    validate_branch_name(&name)?;
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["switch", "-c", &name])?;
        require_success(&out, "Create branch")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Delete a branch. Refuses to delete unmerged branches (exit 1) unless forced
/// by the user, which is intentionally not exposed here.
#[tauri::command]
pub async fn git_delete_branch(
    root: String,
    name: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    validate_branch_name(&name)?;
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["branch", "-d", "--", &name])?;
        require_success(&out, "Delete branch")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branches(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<Vec<GitBranch>, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        branches_inner(&root)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

const GIT_LOG_CAP: usize = 100;

fn parse_log(data: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for line in data.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\0');
        let hash = parts.next().unwrap_or("").to_string();
        let short = parts.next().unwrap_or("").to_string();
        let subject = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").to_string();
        let date = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let refs = parts.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash,
            short,
            subject,
            author,
            date,
            refs,
        });
        if commits.len() >= GIT_LOG_CAP {
            break;
        }
    }
    commits
}

/// List commits on the current branch, newest first, for the commit history
/// view. `%D` gives ref decorations (HEAD, branches, tags) per commit.
#[tauri::command]
pub async fn git_log(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<Vec<GitCommit>, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(
            &root,
            &[
                "log",
                "-n",
                &GIT_LOG_CAP.to_string(),
                "--format=%H%x00%h%x00%s%x00%an%x00%at%x00%D",
            ],
        )?;
        require_success(&out, "Show commit history")?;
        Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Return the repo-relative, forward-slash path of `path` inside `root`.
fn repo_relative(root: &str, path: &str) -> Result<String, String> {
    let root_norm = root.replace('\\', "/").trim_end_matches('/').to_string();
    let path_norm = path.replace('\\', "/");
    let root_lower = root_norm.to_lowercase();
    let path_lower = path_norm.to_lowercase();
    if path_lower == root_lower {
        return Err("Path is the workspace root, not a file".to_string());
    }
    if !path_lower.starts_with(&format!("{root_lower}/")) {
        return Err("Path is outside the workspace".to_string());
    }
    Ok(path_norm[root_norm.len() + 1..].to_string())
}

const GIT_FILE_CAP_BYTES: usize = 4 * 1024 * 1024;

/// Fetch the version of a file at HEAD for the diff "original" side.
/// Returns `None` for untracked files, binary content, or files too large
/// to diff comfortably.
#[tauri::command]
pub async fn git_show_file(
    root: String,
    path: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<Option<String>, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let rel = repo_relative(&root, &path)?;
        let out = run_git(&root, &["show", &format!("HEAD:{rel}")])?;
        if !out.status.success() {
            // Untracked or deleted at HEAD — treat as "no original"
            return Ok(None);
        }
        if out.stdout.contains(&0) {
            return Ok(None); // binary content
        }
        if out.stdout.len() > GIT_FILE_CAP_BYTES {
            return Ok(None); // too large
        }
        Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[derive(serde::Serialize)]
pub struct GitConflictStages {
    /// Merge base (stage 1) — `None` when missing or too large to display.
    pub base: Option<String>,
    /// Our version (stage 2).
    pub ours: Option<String>,
    /// Their version (stage 3).
    pub theirs: Option<String>,
}

/// Fetch the stage contents for an unmerged path. Returns `None` when the
/// path is not currently in a conflicted state.
#[tauri::command]
pub async fn git_conflict_stages(
    root: String,
    path: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<Option<GitConflictStages>, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let rel = repo_relative(&root, &path)?;
        let out = run_git(&root, &["ls-files", "-u", "-z", "--", &rel])?;
        require_success(&out, "Check conflict state")?;
        if out.stdout.is_empty() {
            return Ok(None);
        }
        Ok(Some(GitConflictStages {
            base: show_stage_text(&root, &rel, '1'),
            ours: show_stage_text(&root, &rel, '2'),
            theirs: show_stage_text(&root, &rel, '3'),
        }))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Resolve a conflicted file: `ours`, `theirs`, or `both` (concatenated).
/// Always stages the result, which removes the file from the unmerged list.
#[tauri::command]
pub async fn git_resolve_conflict(
    root: String,
    path: String,
    mode: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "ours" | "theirs" | "both") {
        return Err(format!("Unknown resolve mode: {mode}"));
    }
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let rel = repo_relative(&root, &path)?;
        match mode.as_str() {
            "ours" => {
                let out = run_git(&root, &["checkout", "--ours", "--", &rel])?;
                require_success(&out, "Accept ours")?;
            }
            "theirs" => {
                let out = run_git(&root, &["checkout", "--theirs", "--", &rel])?;
                require_success(&out, "Accept theirs")?;
            }
            "both" => {
                let ours = show_stage_bytes(&root, &rel, '2');
                let theirs = show_stage_bytes(&root, &rel, '3');
                if ours.is_none() && theirs.is_none() {
                    return Err(
                        "File is deleted on both sides — nothing to keep".to_string(),
                    );
                }
                let combined = match (ours, theirs) {
                    (Some(mut a), Some(b)) => {
                        a.push(b'\n');
                        a.extend_from_slice(&b);
                        a
                    }
                    (Some(a), None) => a,
                    (None, Some(b)) => b,
                    (None, None) => unreachable!(),
                };
                let abs = Path::new(root.trim_end_matches(['/', '\\'])).join(&rel);
                std::fs::write(&abs, combined).map_err(|e| {
                    format!("Failed to write resolved file: {e}")
                })?;
            }
            _ => unreachable!(),
        }
        let out = run_git(&root, &["add", "--", &rel])?;
        require_success(&out, "Stage resolution")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Read a single index stage (`1`/`2`/`3`) as text for display. Returns `None`
/// when the stage is missing, binary, or too large.
fn show_stage_text(root: &str, rel: &str, stage: char) -> Option<String> {
    let bytes = show_stage_bytes(root, rel, stage)?;
    if bytes.contains(&0) {
        return None; // binary content
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read a single index stage (`1`/`2`/`3`) as raw bytes. Returns `None` when
/// the stage is missing or too large.
fn show_stage_bytes(root: &str, rel: &str, stage: char) -> Option<Vec<u8>> {
    let out = run_git(root, &["show", &format!(":{stage}:{rel}")]).ok()?;
    if !out.status.success() {
        return None;
    }
    if out.stdout.len() > GIT_FILE_CAP_BYTES {
        return None;
    }
    Some(out.stdout)
}

/// Pull the current branch from its upstream, fast-forward only.
#[tauri::command]
pub async fn git_pull(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git_timeout(
            &root,
            &["pull", "--ff-only"],
            GIT_NETWORK_TIMEOUT_MS,
        )?;
        require_success(&out, "Pull")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Push the current branch to its upstream.
#[tauri::command]
pub async fn git_push(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git_timeout(&root, &["push"], GIT_NETWORK_TIMEOUT_MS)?;
        require_success(&out, "Push")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Publish the current branch to the default remote with `-u` so the
/// upstream is set for future push/pull.
#[tauri::command]
pub async fn git_publish(
    root: String,
    branch: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    validate_branch_name(&branch)?;
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["remote"])?;
        require_success(&out, "List remotes")?;
        let remote = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if remote.is_empty() {
            return Err(
                "No git remotes configured — add a remote to publish this branch"
                    .to_string(),
            );
        }
        let out = run_git_timeout(
            &root,
            &["push", "-u", &remote, &branch],
            GIT_NETWORK_TIMEOUT_MS,
        )?;
        require_success(&out, "Publish branch")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

fn parse_stashes(data: &str) -> Vec<GitStash> {
    let mut stashes = Vec::new();
    for line in data.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\0');
        let reference = parts.next().unwrap_or("");
        let subject = parts.next().unwrap_or("");
        if reference.is_empty() {
            continue;
        }
        stashes.push(GitStash {
            reference: reference.to_string(),
            subject: subject.to_string(),
        });
    }
    stashes
}

#[tauri::command]
pub async fn git_stash_list(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<Vec<GitStash>, String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["stash", "list", "--format=%gd%00%gs"])?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "git stash list failed".to_string()
            } else {
                stderr
            });
        }
        Ok(parse_stashes(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Stash all changes (including untracked) with an optional message.
#[tauri::command]
pub async fn git_stash_push(
    root: String,
    message: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let trimmed = message.trim();
        let out = if trimmed.is_empty() {
            run_git(&root, &["stash", "push", "-u"])?
        } else {
            run_git(&root, &["stash", "push", "-u", "-m", trimmed])?
        };
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if stderr.contains("No local changes to save") {
            return Err("Nothing to stash — working tree is clean".to_string());
        }
        require_success(&out, "Stash")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Restore the most recent stash and drop it.
#[tauri::command]
pub async fn git_stash_pop(
    root: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["stash", "pop"])?;
        require_success(&out, "Pop stash")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Apply a specific stash without dropping it.
#[tauri::command]
pub async fn git_stash_apply(
    root: String,
    reference: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["stash", "apply", &reference])?;
        require_success(&out, "Apply stash")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

/// Drop a specific stash.
#[tauri::command]
pub async fn git_stash_drop(
    root: String,
    reference: String,
    lock: tauri::State<'_, GitLock>,
) -> Result<(), String> {
    let git_lock = lock.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = git_lock
            .lock()
            .map_err(|e| format!("git lock poisoned: {e}"))?;
        let out = run_git(&root, &["stash", "drop", &reference])?;
        require_success(&out, "Drop stash")
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}
