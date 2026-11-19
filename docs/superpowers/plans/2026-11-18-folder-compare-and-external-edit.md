# Folder compare + edit in your own app: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two features.
- **Folder compare:** compare two panes and copy new or changed files either way; it never deletes on sync.
- **Edit in your own app:** open a remote file in a desktop app; each save uploads it back, and
  Shetu asks first when the server copy changed. Unsent edits are kept.

**Architecture:**
- **Transfer-queue changes:**
  - copies keep the source's modified time;
  - uploads can carry `expect_dest`, a server state that must still hold when the file is
    published;
  - the queue gains an internal enqueue and a job-finished feed for other Rust modules.
- **Compare** is a pure TypeScript diff over two listings. Local folders are listed by a new small
  Rust command; copies use the existing `transferFiles`.
- **Edits** follow the transfer queue's pattern. A pure state machine (`edits/state.rs`) holds
  every decision. One loop (`edits/manager.rs`) owns it, together with the `notify` watcher, the
  temp folder, `edits.json` and the commands.

**Tech Stack:** Rust (tokio, russh-sftp 2.4, notify 8, tauri-plugin-opener), React 19, zustand,
vitest, biome.

**Spec:** `docs/superpowers/specs/2026-11-18-folder-compare-and-external-edit-design.md`

## Global Constraints

**Dependencies and formatting**
- Only one new crate: `notify` (latest 8.x stable). No new npm packages.
- Formatting:
  - `rustfmt --edition 2021 <file>` on touched Rust files only, never `cargo fmt`;
  - `bunx biome check --write <file>` on touched web files only;
  - never run either on `db.rs` or `lib.rs` as a whole; hand-format edits there.

**Folder compare**
- A file differs when the sizes differ, or the modified times differ by more than 2 seconds.
- The scan stops at 20,000 entries per side, with the message: "Too many files to compare; pick a smaller folder".
- Sync and the arrows never delete. Delete exists only on rows that are only on the target, and it always confirms.
- Copying a `differs` row uses `replace = true`. Copying a row that's only on one side uses `replace = false`.

**Edit in your own app**
- Files over 50 MB need confirmation before downloading.
- Save handling: wait 1 s after the last change, then check that size and mtime are stable across two looks 250 ms apart.
- Temp copies live in `<app cache>/remote-edits/<edit_id>/<original file name>`, in an owner-only folder (0700 on unix). The edit list is saved in `<app cache>/remote-edits/edits.json`.
- Conflict choices are `Overwrite`, `KeepServer` and `SaveAsCopy`. SaveAsCopy uploads to `name (copy).ext` with `replace = false` and leaves the baseline unchanged.
- An edit is *unsent* while its latest save isn't published.
  - **Stop with unsent work** asks "Upload now / Discard / Keep editing".
  - **Quit** keeps unsent copies, and the next launch lists them as "Not uploaded" with Upload and Discard.
  - **Sign-out** wipes everything.
- Edits don't survive a restart except as "Not uploaded".

**Transfers (all of them)**
- Every transfer keeps the source's modified time. A failure to set it is logged, never fatal.
- `expect_dest` mismatch fails the job with `Operation("conflict: the server copy changed")`.

**Process**
- Never add Claude/AI attribution to commits.

## Review Focus

1. **Editors that save atomically:** VS Code and vim write a new file and rename it over the original, so the old inode vanishes. The watcher must keep seeing saves of that file (Task 8 watches the parent folder; test `rename_over_counts_as_a_save`).
2. **Shetu's own writes:** KeepServer downloads over the temp file, and the watcher must not treat that as a user save and upload it straight back (Task 7 test `own_download_is_not_a_save`).
3. **A save during an upload:** the newer content must still reach the server once that upload finishes (Task 7 test `save_during_upload_uploads_again_after`).
4. **Compare listing errors:** a permission-denied subfolder on either side shows an error instead of producing a partial diff that suggests everything is missing (Task 6 test `listing_error_shows_message_not_rows`).
5. **Restart with an upload still queued:** after Not-uploaded edits are restored, the queued upload job and the edit agree, so there's no duplicate upload and no lost unsent flag (Task 7 test `restore_keeps_unsent_and_forgets_job`).

---

### Task 1: Transfers keep the source's modified time

**Files:**
- Modify: `src-tauri/src/transfers/io.rs` (`finish`, `publish_local_new`, plus a new `set_mtime`)
- Modify: `src-tauri/src/transfers/worker.rs` (pass `job.src_mtime`)

**Interfaces:**
- `io::finish(dst: &Side, part: &str, dest: &str, replace: bool, mtime: i64) -> Result<String, JobError>`. It sets the `.part` file's atime and mtime to `mtime` (seconds) before publishing. Every caller passes `job.src_mtime`.
- `async fn set_mtime(side: &Side, path: &str, mtime: i64)` is best effort and logs failures:
  - local: `std::fs::File::options().write(true).open(path)?.set_times(FileTimes::new().set_modified(t).set_accessed(t))`;
  - SFTP: `set_metadata(path, FileAttributes { mtime: Some(mtime as u32), atime: Some(mtime as u32), ..Default::default() })`.

- [ ] **Step 1: Write the failing tests** in `io.rs` tests:
```rust
#[tokio::test] async fn published_file_keeps_the_source_mtime() // copy src (100 bytes) → part → finish(.., replace=false, mtime=1_600_000_000) → stat(dest).1 == 1_600_000_000
#[tokio::test] async fn replace_publish_keeps_the_source_mtime() // same with replace=true over an existing dest
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib transfers::io`. Compile errors (the new parameter) count as RED; fix the call sites in the tests only, then confirm the assertion fails.
- [ ] **Step 3: Implement.** Add the parameter and call `set_mtime(dst, part, mtime)` before either publish path. Update the call in `worker.rs` to pass `job.src_mtime`. Keep every existing io test passing; pass `0` as the mtime for tests that don't care, and skip setting the time when `mtime <= 0`.
- [ ] **Step 4: Run, expect PASS.** Run `cd src-tauri && cargo test --lib transfers`.
- [ ] **Step 5: Commit.** `feat(transfers): copies keep the source's modified time`

---

### Task 2: `expect_dest` — uploads that must not overwrite a changed server copy

**Files:**
- Modify: `src-tauri/src/transfers/model.rs` (field, plus a pure check)
- Modify: `src-tauri/src/transfers/worker.rs` (check before publish)
- Modify: `src-tauri/src/transfers/manager.rs` (`build_job` sets `expect_dest: None`)

**Interfaces:**
- `TransferJob.expect_dest: Option<(u64, i64)>`, marked `#[serde(default)]`.
- `pub const DEST_CHANGED: &str = "conflict: the server copy changed";`
- `pub fn check_expected_dest(expect: Option<(u64, i64)>, actual: Option<(u64, i64)>) -> Result<(), JobError>`:
  - `None` expectation: `Ok`;
  - a missing or different actual: `Err(Operation(DEST_CHANGED))`.

- [ ] **Step 1: Write the failing tests:**
```rust
// model.rs
#[test] fn expected_dest_rules() {
    assert!(check_expected_dest(None, None).is_ok());
    assert!(check_expected_dest(Some((10, 5)), Some((10, 5))).is_ok());
    assert_eq!(check_expected_dest(Some((10, 5)), Some((11, 5))), Err(JobError::Operation(DEST_CHANGED.into())));
    assert_eq!(check_expected_dest(Some((10, 5)), None), Err(JobError::Operation(DEST_CHANGED.into())));
}
// store.rs
#[test] fn rows_saved_before_expect_dest_still_load() // insert a JSON row without "expectDest" → load_jobs → expect_dest None
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib transfers`.
- [ ] **Step 3: Implement.** In `worker::run`, when the copy succeeded and `job.expect_dest.is_some()`:
  - stat the destination path (missing becomes `None`, and any other stat error is returned as the job error);
  - then call `check_expected_dest` before `io::finish`.
  - The check runs outside the stop race, like publishing itself.
- [ ] **Step 4: Run, expect PASS.** Run `cd src-tauri && cargo test --lib transfers`.
- [ ] **Step 5: Commit.** `feat(transfers): uploads can require the server copy to be unchanged`

---

### Task 3: Internal enqueue and a job-finished feed

**Files:**
- Modify: `src-tauri/src/transfers/manager.rs`

**Interfaces:**
- `#[derive(Clone, Debug, PartialEq)] pub struct JobFinished { pub id: String, pub status: JobStatus, pub error: Option<String> }`
- `pub fn finished_of(jobs: &[TransferJob]) -> Vec<JobFinished>` returns Done, Failed and Cancelled jobs only.
- `impl TransferManager`:
  - `pub async fn enqueue_built(&self, jobs: Vec<TransferJob>) -> Result<Vec<TransferJob>, String>` asks `Epoch`, then sends `Enqueue` with an empty `prefer`.
  - `pub fn subscribe_finished(&self) -> mpsc::UnboundedReceiver<JobFinished>` registers a sender through a new `Msg::Subscribe(sender)`.
  - The loop keeps the subscribers. In `apply(Effect::Changed(jobs))` it sends `finished_of(&jobs)` to each one, and drops subscribers whose send fails.

- [ ] **Step 1: Write the failing test:**
```rust
#[test] fn finished_of_reports_terminal_jobs_only() // jobs: Queued, Active, Done, Failed(error "x"), Cancelled → ids of the last three with statuses and error Some("x")
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib transfers::manager`.
- [ ] **Step 3: Implement the struct, the function, the two methods and the `Subscribe` message.**
- [ ] **Step 4: Run, expect PASS.** Run `cd src-tauri && cargo test --lib transfers`.
- [ ] **Step 5: Commit.** `feat(transfers): internal enqueue and job-finished feed`

---

### Task 4: `local_list_recursive` command

**Files:**
- Create: `src-tauri/src/local_list.rs`
- Modify: `src-tauri/src/lib.rs` (`mod local_list;` and register the command)

**Interfaces:**
- `#[derive(Serialize)] #[serde(rename_all="camelCase")] pub struct ListEntry { path: String, is_dir: bool, size: u64, mtime: i64 }`:
  - `path` is relative to the root and uses `/`;
  - `mtime` is in seconds, `0` when unknown.
- `pub fn list_recursive(root: &Path, cap: usize) -> Result<Vec<ListEntry>, String>`:
  - symlinks are listed as files and not followed;
  - an unreadable subfolder is an `Err` naming its path;
  - more than `cap` entries returns `Err("Too many files to compare; pick a smaller folder")`.
- `#[tauri::command] pub async fn local_list_recursive(path: String, cap: usize) -> Result<Vec<ListEntry>, String>` runs it on a blocking thread.

- [ ] **Step 1: Write the failing tests** (temp dir per test, as in `transfers::io` tests):
```rust
#[test] fn lists_files_and_folders_with_sizes_and_times() // a.txt (3 bytes), sub/b.txt, empty/ → 4 entries incl. "sub", "sub/b.txt", "empty"; a.txt size 3, mtime > 1_600_000_000
#[test] fn cap_is_an_error() // 5 files, cap 3 → Err with the exact cap message
#[cfg(unix)] #[test] fn unreadable_subfolder_is_an_error() // chmod 000 sub → Err containing "sub"
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib local_list`.
- [ ] **Step 3: Implement it with `std::fs::read_dir` and an explicit stack** (no new crate).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `feat: list a local folder recursively with sizes and times`

---

### Task 5: `compareFolders` (pure TS)

**Files:**
- Create: `src/lib/sftp/compareFolders.ts`
- Test: `src/lib/sftp/compareFolders.test.ts`

**Interfaces:**
- `export interface CompareEntry { path: string; isDir: boolean; size: number; mtime: number }` with relative paths and mtime in seconds.
- `export type CompareStatus = "onlyLeft" | "onlyRight" | "differs" | "same" | "conflict";`
- `export interface CompareRow { path: string; status: CompareStatus; isDir: boolean; left?: CompareEntry; right?: CompareEntry }`
- `export function compareFolders(left: CompareEntry[], right: CompareEntry[]): CompareRow[]`:
  - rows are sorted by path;
  - a folder present on both sides isn't a row;
  - a folder present on one side is a row only if no file under it is a row (empty folders).
- `export function toCompareEntries(root: string, items: FileItem[]): CompareEntry[]` turns remote listings into relative entries: separators normalised to `/`, `mtime` = `Date.parse(modifiedAt) / 1000` floored.

- [ ] **Step 1: Write the failing tests:**
```ts
it("marks only-left, only-right, same and differs")
it("treats a 2 s time difference as same and 3 s as differs")   // mtime 100 vs 102 → same; 100 vs 103 → differs
it("treats a size difference as differs even with equal times")
it("flags a file on one side and a folder on the other as conflict")
it("lists an empty folder that exists only on one side")
it("does not list a folder whose files are listed")
it("normalises backslash paths from local listings")             // via toCompareEntries("C:\\site", items with "C:\\site\\a\\b.txt")
```
- [ ] **Step 2: Run, expect FAIL.** Run `bunx vitest run src/lib/sftp/compareFolders.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `feat(sftp): folder diff`

---

### Task 6: Compare view

**Files:**
- Create: `src/components/sftp/compare/CompareView.tsx`, `src/hooks/sftp/useFolderCompare.ts`
- Modify: the toolbar of `FileBrowser.tsx` and `LocalFileBrowser.tsx` (a Compare button), `src/stores/sftp/sftpStore.ts` (`compare: { leftPaneId, rightPaneId } | null`, `openCompare`, `closeCompare`)
- Test: `src/components/sftp/compare/CompareView.test.tsx`, `src/hooks/sftp/useFolderCompare.test.ts`

**Interfaces:**
- `useFolderCompare(leftPaneId, rightPaneId)` returns `{ rows, loading, error, rescan, copy(rows, direction: "right" | "left"), remove(row), cancel }`:
  - **Listing:** `invoke("local_list_recursive", { path, cap: 20000 })` for local panes; for remote panes, `provider.listFilesRecursive` plus `toCompareEntries`, with an error past 20,000 entries.
  - **Copy:** `transferFiles` with the panes' providers (`getProvider`). Each row's file is copied with its relative path. The `replace` override is set only for `differs` rows; the target folders are created by `transferFiles`' existing `mkdirAll`. It rescans when the copy resolves.
  - **Delete:** the target pane provider's `removeFile` / `delete`, only for rows that are only on the target, after `confirm`.
- **Compare button behaviour:**
  - with 2 panes, it opens compare with the other pane;
  - with more than 2, a menu lists the other panes (`hostName` or `Local` plus `currentPath`);
  - with 1 pane, it's disabled, with the title "Open a second pane to compare".
- **View:**
  - rows show a badge `+`, `−`, `≠` or `!` (conflict, never copyable) and the left and right size and time;
  - the arrows are **→** on onlyLeft and differs rows and **←** on onlyRight and differs rows;
  - the "Show identical (N)" toggle is off by default;
  - with rows selected, "Copy selected →" and "← Copy selected" appear;
  - "Sync →" copies every onlyLeft and differs row, and "← Sync" the reverse;
  - "Delete" appears only on rows that are only on the side being synced to (both directions offer it on the side where the file exists alone);
  - Rescan, Close.

- [ ] **Step 1: Write the failing tests:**
```ts
// useFolderCompare.test.ts (mock invoke + providers)
it("Sync → copies onlyLeft and differs with replace only for differs")
it("listing_error_shows_message_not_rows")   // remote listFilesRecursive rejects "Permission denied" → error set, rows []
it("rescans after a copy finishes")
// CompareView.test.tsx
it("shows arrows per status and hides identical rows by default")
it("never offers copy on a conflict row")
it("asks before deleting and only offers delete on target-only rows")
```
- [ ] **Step 2: Run, expect FAIL.** Run `bunx vitest run src/components/sftp/compare src/hooks/sftp/useFolderCompare.test.ts`.
- [ ] **Step 3: Implement**, reusing the existing `Button`, the dialog components and the row styles from `FileTransfer.tsx`.
- [ ] **Step 4: Run, expect PASS.** Also run `bunx tsc --noEmit` and `bunx biome check <touched files>`.
- [ ] **Step 5: Commit.** `feat(sftp): compare two folders and copy across`

---

### Task 7: Edit state machine (pure Rust)

**Files:**
- Create: `src-tauri/src/edits/mod.rs` (declares `state` and `manager`), `src-tauri/src/edits/state.rs`
- Modify: `src-tauri/src/lib.rs` (`mod edits;`)

**Interfaces** (all serde camelCase):
- `pub struct Edit { id, session_id: String, host: HostRef, remote_path, local_path, baseline: (u64, i64), last_local: (u64, i64), unsent: bool, status: EditStatus, job: Option<String>, uploading: Option<(u64, i64)>, dirty: bool, conflict: Option<(u64, i64)>, error: Option<String> }`
  - `uploading` is the local stat being uploaded;
  - `dirty` means a save happened during an upload.
- `pub enum EditStatus { Watching, Uploading, Conflict, NotUploaded }`
- `pub enum Choice { Overwrite, KeepServer, SaveAsCopy }`
- `pub enum EditEffect`:
  - `Upload { edit_id, local_path, remote_path, replace: bool, expect: Option<(u64, i64)> }`
  - `Download { edit_id }` (KeepServer)
  - `Conflict { edit_id, remote: (u64, i64) }`
  - `Changed` (emit the list and persist `edits.json`)
  - `Remove { edit_id, local_dir }`
- `pub struct EditState { edits: Vec<Edit> }` with:
  - `opened(edit) -> Vec<EditEffect>`;
  - `find(session_id, remote_path) -> Option<&Edit>`;
  - `saved(id, local, remote: Option<(u64, i64)>) -> Vec<EditEffect>`:
    - ignored when `local == last_local`;
    - with a conflict pending: `last_local = local`, unsent, no upload;
    - while uploading: `dirty = true`;
    - when `remote == Some(baseline)`: `Upload { replace: true, expect: Some(baseline) }`, status Uploading, `uploading = Some(local)`, unsent;
    - otherwise: Conflict, status Conflict, unsent.
  - `enqueued(id, job_id)`;
  - `job_finished(job_id, status, error)`:
    - Done: `baseline = uploading` (the copy keeps the local mtime, so the server now matches it);
      unsent becomes `dirty`; if dirty, upload again;
    - Failed with `DEST_CHANGED`: Conflict (needs the remote; the manager stats and calls `conflict_found`);
    - other failures: Watching with the error, unsent stays true;
    - Cancelled: Watching, unsent stays.
  - `conflict_found(id, remote) -> Vec<EditEffect>`;
  - `resolve(id, choice, remote_now: (u64, i64))`:
    - Overwrite: upload with `expect = Some(remote_now)`;
    - KeepServer: `Download`;
    - SaveAsCopy: upload to `free name (copy)` with `replace: false`, `expect: None`, baseline unchanged; unsent is cleared when that upload is Done.
  - `downloaded(id, local, remote) -> Vec<EditEffect>`: `baseline = remote`, `last_local = local`, unsent false, status Watching.
  - `upload_now(id)`: upload with `expect = Some(baseline)`.
  - `stop(id, discard: bool) -> Result<Vec<EditEffect>, String>`: `Err("unsent")` when unsent and not discarding.
  - `restore(saved: Vec<Edit>) -> Vec<EditEffect>`: unsent edits become `NotUploaded` with `job = None` and `dirty = false`; the rest become `Remove`.
  - `wipe() -> Vec<EditEffect>`: `Remove` for every edit.
  - `list() -> Vec<Edit>`.
- `pub fn needs_confirm(size: u64, confirmed: bool) -> bool` is true when `size > 50 * 1024 * 1024 && !confirmed`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn save_with_unchanged_server_uploads_expecting_the_baseline()
#[test] fn save_after_server_changed_asks_and_does_not_upload()
#[test] fn saves_while_conflict_pending_never_upload()
#[test] fn own_download_is_not_a_save()                  // KeepServer → downloaded(local L) → saved(L, ..) yields nothing
#[test] fn save_during_upload_uploads_again_after()      // saved → Upload; saved again → no effect, dirty; job_finished Done → Upload again
#[test] fn done_sets_baseline_to_uploaded_local_and_clears_unsent()
#[test] fn dest_changed_failure_becomes_a_conflict()
#[test] fn other_failure_keeps_unsent()
#[test] fn overwrite_expects_the_current_server_state()
#[test] fn save_as_copy_keeps_baseline_and_next_save_conflicts()
#[test] fn stop_with_unsent_needs_discard()
#[test] fn restore_keeps_unsent_and_forgets_job()         // a restored unsent edit is NotUploaded, job None; a sent one → Remove
#[test] fn wipe_removes_everything()
#[test] fn over_50mb_needs_confirmation()                 // 50 MiB → false; 50 MiB + 1 → true unless confirmed
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib edits::state`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `feat(edits): state machine for editing remote files in your own app`

---

### Task 8: Edit manager — loop, watcher, temp files, commands

**Files:**
- Create: `src-tauri/src/edits/manager.rs`
- Modify: `src-tauri/Cargo.toml` (`notify = "8"`, latest 8.x), `src-tauri/src/lib.rs`:
  - manage `EditManager::new(app)` after `TransferManager`;
  - register the commands;
  - `wipe_local_data` awaits `edits.wipe()`;
  - register `tauri_plugin_opener` if it isn't already.

**Interfaces:**
- **Commands:**
  - `edit_open(session_id, remote_path, app: Option<String>, confirm_large: bool) -> Result<Edit, String>`. Over the limit without confirmation it returns `Err("large:<bytes>")`. It reuses an existing edit for the same session and path, and just reopens it.
  - `edit_list() -> Vec<Edit>`;
  - `edit_stop(id, discard: bool) -> Result<(), String>` (`Err("unsent")` passes through);
  - `edit_resolve(id, choice: Choice) -> Result<(), String>`;
  - `edit_upload_now(id) -> Result<(), String>`.
- **Events:**
  - `edits://changed` carries `Vec<Edit>`;
  - `edits://conflict` carries `{ id, fileName, host, remotePath }`.
- **Loop:**
  - one mpsc loop owns `EditState`, like `transfers::manager`;
  - inputs: commands, watcher saves (after the debounce and stability check), `JobFinished` from `TransferManager::subscribe_finished()`, and stat or download results;
  - effects:
    - `Upload` builds an upload job with `transfers::manager::build_job` (`NewJob { kind: Upload, src_path: local_path, dest_path, src_session_id: None, dest_session_id: None, replace }`, src host `None`, dest host = `edit.host`, snapshot = local stat), sets `expect_dest = expect`, calls `TransferManager::enqueue_built`, then `enqueued(edit_id, job.id)`;
    - `Download` copies through `io::copy` into `<temp>.part` and renames it over the temp file, then `downloaded`;
    - `Changed` writes `edits.json` (write to a temp file, then rename) and emits;
    - `Remove` deletes the edit's folder;
    - `Conflict` emits `edits://conflict`.
- **Watcher:**
  - one `notify::RecommendedWatcher` watching each edit's folder (not the file);
  - events for the edit's file name, including a rename over it, restart a 1 s timer; then two stats 250 ms apart; if they're equal, stat the remote through the session (`SftpSessions::session_info`) and send `saved`.
  - If the session is gone, mark the edit with the error "Connection closed — reopen the pane" and still record the save as unsent.
- **Startup:** `restore` from `edits.json`; keep unsent edits and ones changed on disk since last seen (listed as Not uploaded), delete only the other remote-edits folders, and none at all if the list can't be read. Quitting deletes nothing.
- **Opening:** use `app.opener().open_path(local_path, app)`.

- [ ] **Step 1: Write the failing tests** (pure helpers only; the loop is glue):
```rust
#[test] fn edits_json_roundtrip_and_missing_file_is_empty()   // save_edits(dir, &[edit]) → load_edits(dir) == [edit]; missing → Ok(vec![])
#[tokio::test] async fn rename_over_counts_as_a_save()        // a real notify watcher on a temp dir: write tmp, rename over file → debounced channel yields the file once within 3 s
#[test] fn temp_dir_is_owner_only()                            // cfg(unix): create_edit_dir mode & 0o777 == 0o700
```
- [ ] **Step 2: Run, expect FAIL.** Run `cd src-tauri && cargo test --lib edits::manager`.
- [ ] **Step 3: Implement the manager, the commands and the `lib.rs` wiring.**
- [ ] **Step 4: Run, expect PASS.** Run `cd src-tauri && cargo test` (whole crate) and check `cargo clippy --all-targets` is clean for `src/edits` and `src/transfers`.
- [ ] **Step 5: Commit.** `feat(edits): open remote files in your own app and upload on save`

---

### Task 9: Web — menu, editing list, conflict and stop dialogs

**Files:**
- Create: `src/lib/sftp/edits.ts` (wrappers and types), `src/components/sftp/edits/EditingList.tsx`, `src/components/sftp/edits/EditConflictDialog.tsx`
- Modify:
  - `src/components/sftp/browser/shared/buildContextMenuItems.tsx`: "Open in default app" and "Open with…", for remote files only;
  - `src/stores/sftp/sftpStore.ts`: an `edits: Edit[]` mirror, plus a listener on `edits://changed` and `edits://conflict` started with the transfer listener;
  - `src/stores/settings/settingsStore.ts`: `openWithApps: Record<string, string>`;
  - `src/components/sftp/transfer/FileTransfer.tsx`: render `EditingList` above the transfers.
- Test: `EditingList.test.tsx`, `EditConflictDialog.test.tsx`, `src/lib/sftp/edits.test.ts`

**Interfaces:**
- **`openRemoteFile(paneSessionId, path, { withApp?: boolean })`:**
  - A `large:<bytes>` error shows `confirm("<name> is <size>. Download and open it?")` and retries with `confirm_large: true`.
  - `withApp` uses the remembered app for the file's extension. If there's none, it opens the dialog plugin's file picker, remembers the choice and passes it.
- **`EditingList` rows:**
  - file name, host and path;
  - status label: Watching / Uploading… / "Conflict: server copy changed" / Not uploaded;
  - buttons: **Open again** (reruns `edit_open`), **Upload** (only when Not uploaded), **Resolve** (only on Conflict), **Stop**.
  - **Stop** on an unsent edit opens "Upload now / Discard / Keep editing": Upload calls `edit_upload_now`, Discard calls `edit_stop(id, true)`, and Keep editing closes.
- **Pane disconnect:** in `sftpStore.disconnectSftp` and wherever a host pane closes, call `edit_stop(id, false)` for that session's edits. Unsent ones return `"unsent"` and are left running, so they upload once the pane reconnects or through Upload.
- **`EditConflictDialog`:**
  - text: "<file> changed on <host> since you opened it.";
  - buttons: "Overwrite server" / "Keep server's version" / "Save mine as a copy", each calling `edit_resolve` with the matching choice;
  - closing it leaves the conflict pending.

- [ ] **Step 1: Write the failing tests:**
```ts
it("offers Open in default app / Open with… only for remote files")
it("asks before opening a large file and retries confirmed")
it("Open with… remembers the chosen app per extension")
it("Stop on an unsent edit offers Upload now, Discard, Keep editing")
it("conflict dialog buttons call edit_resolve with the right choice")
it("mirrors edits://changed")
it("closing a pane stops its sent edits and keeps unsent ones")
```
- [ ] **Step 2: Run, expect FAIL.** Run `bunx vitest run src/components/sftp/edits src/lib/sftp/edits.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Run `bunx vitest run`, `bunx tsc --noEmit`, and `bunx biome check <touched files>`.
- [ ] **Step 5: Commit.** `feat(edits): open with your own app, editing list and conflict dialog`
- [ ] **Step 6: Manual check, recorded in the ledger:** `bun run tauri dev`.
  - Edit a remote file in a desktop editor and save twice; check it uploads.
  - Change the file on the server, save, and check the dialog appears.
  - Compare a local folder with a remote one, then Sync → and Rescan.
  - If no SSH host is reachable, write in the ledger that this was skipped.
