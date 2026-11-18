# Resumable Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SFTP transfers write to per-job `.part` files, resume after drops/restarts, retry by themselves, and live in a saved Rust-owned queue the UI mirrors.

**Architecture:** New Rust module `src-tauri/src/transfers/` owns the queue: pure model + state machine (`model.rs`, `queue.rs`), SQLite persistence (`store.rs`), endpoint I/O with `.part`/resume/rename (`io.rs`), and the async manager with Tauri commands, scheduling, retries and connection acquisition (`manager.rs`). The web layer keeps scanning/conflicts/mkdir in `transferFiles`, enqueues remote jobs in one call, and mirrors manager state in `sftpStore`; the old `sftp_download/upload/server_copy/cancel_transfer` commands go away.

**Tech Stack:** Rust (tokio, russh-sftp 2.4, rusqlite, serde, tokio-util CancellationToken), Tauri v2 events/commands, React 19 + zustand, vitest (happy-dom), biome.

**Spec:** `docs/superpowers/specs/2026-11-18-resumable-transfers-design.md`

## Global Constraints

- No new crates or npm packages.
- `.part` name: `<dest>.<first 8 chars of job id>.part`; only the owning job adopts it.
- 3 jobs `active` at a time; `waiting` jobs don't hold a place.
- Retries: connection errors only, up to 5, delays 2 s, 4 s, 8 s, 16 s, 32 s (each capped at 60 s); when unsure, classify as connection.
- Resume continues from the `.part` size only if source size + mtime match the enqueue snapshot and the `.part` is no bigger than the source; otherwise truncate and restart from zero. Server copies always restart from zero.
- After restart: `queued`/`active`/`waiting` → `paused`; `failed` stays; `done`/`cancelled` dropped. Nothing resumes on its own.
- Saved queue holds paths + host references only, never passwords/keys; table is in `shetu.db` and listed in `db::wipe_all`. Sign-out/device wipe cancels jobs and empties the table; `.part` files are left on disk.
- A `new` job whose destination appeared after queueing finishes under the next free name (the existing auto-rename rule) instead of overwriting.
- Status labels: Queued, Transferring, Paused, "Retrying in 8 s (2 of 5)", "Waiting for unlock", "Waiting for <host>", Failed, Done.
- Formatting: `rustfmt --edition 2021 <file>` on touched Rust files only (never `cargo fmt`); `bunx biome check --write <file>` on touched web files only.
- Never add Claude/AI attribution to commits.

## Review Focus

1. Pause/cancel while an SFTP read or write hangs on a dead connection: the row flips at once and the stuck task can't later overwrite that status (Task 2 test `finish_after_pause_keeps_paused`; Task 5 races the copy against the token).
2. Device wipe during a running transfer: the finishing task must not write its row back into the emptied table (Task 2 test `finish_unknown_job_is_noop`; Task 5 `wipe` path).
3. Destination folder deleted while a job is queued: must fail with a message, not loop through 5 retries (Task 1 test `classify_io_not_found_is_operation`).
4. The same file queued twice to the same folder: both finish, the second under the "(copy)" name, nothing overwritten (Task 4 test `finish_new_with_existing_dest_uses_free_name`).
5. `transferFiles` callers waiting on a job the user cancels, pauses, or that waits for a quick-connect host: the promise resolves (Task 6 tests `resolves_when_job_paused` and `treats_host_wait_as_handed_off`).

---

### Task 1: Transfer model and pure rules

**Files:**
- Create: `src-tauri/src/transfers/mod.rs` (declares `model`, `queue`, `store`, `io`, `manager`; re-exports `manager::TransferManager` and commands, added as each task lands)
- Create: `src-tauri/src/transfers/model.rs`
- Modify: `src-tauri/src/lib.rs` (`mod transfers;`)

**Interfaces:**
- Produces (all `serde(rename_all = "camelCase")`, enums `rename_all = "lowercase"`):
  - `struct HostRef { host_id: Option<String>, host: String, port: u16, username: String }` (`host_id` Some = saved host)
  - `struct Endpoint { path: String, host: Option<HostRef> }` (`None` = local)
  - `enum JobKind { Download, Upload, ServerCopy }`
  - `enum JobStatus { Queued, Active, Paused, Waiting, Failed, Done, Cancelled }`
  - `enum WaitReason { Retry, Unlock, Host }`
  - `struct TransferJob { id, kind, src: Endpoint, dest: Endpoint, replace: bool, part_path: String, src_size: u64, src_mtime: i64, status, transferred: u64, attempt: u32, next_retry_at: Option<i64>, wait_reason: Option<WaitReason>, error: Option<String>, created_at: i64, #[serde(default)] speed: f64 }` (times in ms since epoch)
  - `enum JobError { Connection(String), Operation(String), Stopped }` where `Stopped` means our token fired
  - `enum ErrorClass { Connection, Operation }`
  - `const MAX_ACTIVE: usize = 3; const MAX_ATTEMPTS: u32 = 5;`
  - `fn part_path(dest: &str, id: &str) -> String`
  - `fn resume_offset(part_len: Option<u64>, snapshot: (u64, i64), now: (u64, i64)) -> u64`
  - `fn retry_delay(attempt: u32) -> std::time::Duration`
  - `fn classify_io(e: &std::io::Error) -> ErrorClass`
  - `fn classify_sftp(e: &russh_sftp::client::error::Error) -> ErrorClass`
  - `fn free_name(dest: &str, exists: impl Fn(&str) -> bool) -> String`

- [ ] **Step 1: Write the failing tests** in `model.rs` `#[cfg(test)] mod tests`:

```rust
#[test] fn part_path_uses_first_8_chars_of_id() {
    assert_eq!(part_path("/d/a.tar", "1a2b3c4d-9999"), "/d/a.tar.1a2b3c4d.part");
}
#[test] fn resume_offset_rules() {
    let s = (100, 7);
    assert_eq!(resume_offset(None, s, s), 0);
    assert_eq!(resume_offset(Some(40), s, s), 40);
    assert_eq!(resume_offset(Some(100), s, s), 100);
    assert_eq!(resume_offset(Some(101), s, s), 0);      // bigger than source
    assert_eq!(resume_offset(Some(40), s, (100, 8)), 0); // mtime changed
    assert_eq!(resume_offset(Some(40), s, (120, 7)), 0); // size changed
}
#[test] fn retry_delay_schedule() {
    let secs: Vec<u64> = (1..=5).map(|a| retry_delay(a).as_secs()).collect();
    assert_eq!(secs, vec![2, 4, 8, 16, 32]);
    assert_eq!(retry_delay(9).as_secs(), 60);
}
#[test] fn classify_io_not_found_is_operation() {
    use std::io::{Error, ErrorKind};
    assert_eq!(classify_io(&Error::from(ErrorKind::NotFound)), ErrorClass::Operation);
    assert_eq!(classify_io(&Error::from(ErrorKind::PermissionDenied)), ErrorClass::Operation);
    assert_eq!(classify_io(&Error::from(ErrorKind::ConnectionReset)), ErrorClass::Connection);
    assert_eq!(classify_io(&Error::other("??")), ErrorClass::Connection);
}
#[test] fn classify_sftp_status_codes() {
    // Status NoSuchFile / PermissionDenied / OpUnsupported → Operation; Timeout, IO, other → Connection
}
#[test] fn free_name_follows_copy_rule() {
    let taken = ["/d/a.txt", "/d/a (copy).txt"];
    assert_eq!(free_name("/d/a.txt", |p| taken.contains(&p)), "/d/a (copy 2).txt");
    assert_eq!(free_name("/d/noext", |_| false), "/d/noext (copy)");
}
```
(`classify_sftp_status_codes`: build `Error::Status(Status { status_code: StatusCode::NoSuchFile, .. })` etc. from russh-sftp 2.4's types and assert each class.)

- [ ] **Step 2: Run, expect FAIL** — `cd src-tauri && cargo test transfers::model` → compile errors (items missing).

- [ ] **Step 3: Implement the types and functions.** `free_name` mirrors `generateAutoName` in `src/lib/sftp/fileTransfer.ts`: `<base> (copy)<ext>`, then `<base> (copy N)<ext>` from N=2; the dot rule is `lastIndexOf('.') > 0` on the file name only; the parent dir and separator (`/` or `\`) are kept as given. `classify_io`: `NotFound | PermissionDenied | AlreadyExists | InvalidInput | IsADirectory | NotADirectory | StorageFull | ReadOnlyFilesystem` → Operation (use the kinds stable on the crate's MSRV; drop any that aren't), else Connection.

- [ ] **Step 4: Run, expect PASS** — `cd src-tauri && cargo test transfers::model`.

- [ ] **Step 5: Commit** — `rustfmt --edition 2021 src-tauri/src/transfers/*.rs`; `git commit -m "feat(transfers): job model, resume and retry rules"`.

---

### Task 2: Queue state machine

**Files:**
- Create: `src-tauri/src/transfers/queue.rs`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `struct Queue { jobs: Vec<TransferJob> }` (insertion order = age) with:
  - `fn restore(jobs: Vec<TransferJob>) -> Queue` — applies the restart mapping, drops done/cancelled, clears `wait_reason`/`next_retry_at`/`speed`.
  - `fn enqueue(&mut self, jobs: Vec<TransferJob>)`
  - `fn startable(&self) -> Vec<String>` — oldest `queued` ids while `active` count < `MAX_ACTIVE`.
  - `fn mark_active(&mut self, id: &str)`
  - `fn set_waiting(&mut self, id: &str, reason: WaitReason)` (no attempt change; for Unlock/Host)
  - `fn finish(&mut self, id: &str, result: Result<(), JobError>, now: i64) -> Option<&TransferJob>` — `None` if the id is unknown or the job isn't `active`.
  - `fn due(&mut self, now: i64) -> Vec<String>` — `waiting`+`Retry` with `next_retry_at <= now` → `queued`.
  - `fn pause(&mut self, id) -> bool`, `fn resume(&mut self, id) -> bool`, `fn resume_all(&mut self) -> Vec<String>`, `fn retry(&mut self, id) -> bool`, `fn cancel(&mut self, id) -> Option<TransferJob>` (returns the job so the caller can delete its `.part`), `fn clear_finished(&mut self) -> Vec<String>`, `fn forget_all(&mut self)`, `fn get(&self, id) -> Option<&TransferJob>`, `fn all(&self) -> &[TransferJob]`.
  - `fn waiting_for(&self, reason: WaitReason) -> Vec<String>`, `fn wake(&mut self, id) -> bool` (waiting → queued).

- [ ] **Step 1: Write the failing tests** (helper `job(id, status)` builds a minimal job):

```rust
#[test] fn startable_caps_active_and_ignores_waiting() // 2 active + 1 waiting + 3 queued → exactly 1 startable, the oldest queued
#[test] fn connection_error_waits_with_backoff() {
    // finish(Err(Connection)) at now=1000 → Waiting, Retry, attempt 1, next_retry_at 3000
}
#[test] fn sixth_connection_error_fails() // attempt 5 + Connection → Failed, error set
#[test] fn operation_error_fails_at_once() // attempt 0 + Operation("denied") → Failed, error "denied"
#[test] fn due_requeues_only_elapsed_retries() // next_retry_at 3000: due(2999) empty, due(3000) → queued
#[test] fn finish_after_pause_keeps_paused() // active → pause() → finish(Err(Stopped)) returns None, status Paused
#[test] fn finish_after_cancel_keeps_cancelled() // active → cancel() → finish(Ok) returns None, status Cancelled
#[test] fn finish_unknown_job_is_noop() // forget_all(); finish("x", Ok) → None, all() empty
#[test] fn resume_and_retry_reset_attempts() // paused/failed with attempt 3 → resume()/retry() → Queued, attempt 0, error None
#[test] fn restore_maps_statuses() // queued/active/waiting→paused, failed stays, done/cancelled dropped
#[test] fn pause_frees_a_slot() // 3 active, pause one → startable() returns the oldest queued
#[test] fn clear_finished_removes_done_and_cancelled_only()
```

- [ ] **Step 2: Run, expect FAIL** — `cd src-tauri && cargo test transfers::queue`.

- [ ] **Step 3: Implement `Queue`.** `pause` applies to queued/active/waiting; `cancel` to any non-done status; `finish(Ok)` sets `transferred = src_size`, `Done`; `finish(Err(Stopped))` on an `active` job (stopped without pause/cancel, e.g. shutdown) → `Paused`.

- [ ] **Step 4: Run, expect PASS** — `cd src-tauri && cargo test transfers::queue`.

- [ ] **Step 5: Commit** — `feat(transfers): queue state machine`.

---

### Task 3: Saved queue in `shetu.db`

**Files:**
- Create: `src-tauri/src/transfers/store.rs`
- Modify: `src-tauri/src/db.rs` (schema in `open`, `wipe_all` list)

**Interfaces:**
- Consumes: `TransferJob`, `Queue::restore`.
- Produces: `fn save_job(db: &LocalDb, job: &TransferJob) -> Result<(), String>` (upsert), `fn delete_jobs(db: &LocalDb, ids: &[String]) -> Result<(), String>`, `fn load_jobs(db: &LocalDb) -> Result<Vec<TransferJob>, String>` (oldest first, rows that fail to parse are skipped and deleted), `fn clear_jobs(db: &LocalDb) -> Result<(), String>`.
- Table: `CREATE TABLE IF NOT EXISTS transfer_jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL)` (`data` = the job's JSON without `speed`).

- [ ] **Step 1: Write the failing tests** (`store.rs`, using `db::open(":memory:")`):

```rust
#[test] fn save_load_roundtrip_keeps_order()
#[test] fn save_is_upsert() // save twice with new status → one row, latest status
#[test] fn delete_and_clear()
#[test] fn bad_row_is_skipped_and_removed() // insert data "not json" → load_jobs Ok, empty; row gone
```
and in `db.rs` tests: `#[test] fn wipe_all_clears_transfer_jobs()` — insert a row, `wipe_all`, count 0.

- [ ] **Step 2: Run, expect FAIL** — `cd src-tauri && cargo test transfers::store db::tests::wipe_all_clears_transfer_jobs`.

- [ ] **Step 3: Add the table to the `open` schema batch, `"transfer_jobs"` to `wipe_all`, implement the functions.**

- [ ] **Step 4: Run, expect PASS** — same command.

- [ ] **Step 5: Commit** — `feat(transfers): save the queue in the local database`.

---

### Task 4: Endpoint I/O — `.part`, resume, finish

**Files:**
- Create: `src-tauri/src/transfers/io.rs`

**Interfaces:**
- Consumes: Task 1 (`resume_offset`, `free_name`, `classify_*`, `JobError`).
- Produces:
  - `enum Side { Local, Sftp(Arc<russh_sftp::client::SftpSession>) }`
  - `async fn stat(side: &Side, path: &str) -> Result<(u64, i64), JobError>` (size, mtime seconds)
  - `async fn part_len(side: &Side, part: &str) -> Result<Option<u64>, JobError>`
  - `async fn copy(src: &Side, src_path: &str, dst: &Side, part: &str, offset: u64, stop: &CancellationToken, progress: impl FnMut(u64)) -> Result<(), JobError>` — opens source at `offset` (seek), opens `part` for writing (offset 0 → create+truncate; else write without truncate, seek to `offset`), 64 KiB chunks, every read/write raced against `stop` (`tokio::select!`, `stop` → `Err(Stopped)`), `progress(total_written_including_offset)` after each chunk, flush + `sync_all` at end.
  - `async fn finish(dst: &Side, part: &str, dest: &str, replace: bool) -> Result<String, JobError>` — returns the final path. If `!replace` and `dest` exists → `free_name`. Local: `tokio::fs::rename`. SFTP: if target exists, `remove_file` then `rename`; if rename fails after the remove the `.part` is kept and the error returned.
  - `async fn remove_part(side: &Side, part: &str)` (best effort, ignores errors).
- Errors map through `classify_io`/`classify_sftp` into `JobError::{Connection, Operation}` with the operation in the message (`"open: …"`, `"write: …"`).

- [ ] **Step 1: Write the failing tests** (local→local through `Side::Local`, `tempfile`-free: use `std::env::temp_dir()` + a unique subdir per test, removed at the end):

```rust
#[tokio::test] async fn copy_from_zero_then_finish_renames()
#[tokio::test] async fn copy_resumes_by_appending_from_offset() // part holds first 40 bytes of a 100-byte source → copy(offset 40) → finish → dest equals source
#[tokio::test] async fn copy_offset_zero_truncates_existing_part() // part has junk 500 bytes → copy(0) → dest equals source (100 bytes)
#[tokio::test] async fn stopped_copy_returns_stopped_and_keeps_part() // token cancelled before copy → Err(Stopped), part exists
#[tokio::test] async fn finish_new_with_existing_dest_uses_free_name() // dest exists, replace=false → returns ".../a (copy).txt", original untouched
#[tokio::test] async fn finish_replace_overwrites_dest()
#[tokio::test] async fn copy_missing_source_is_operation_error()
#[tokio::test] async fn remove_part_deletes_file()
```

- [ ] **Step 2: Run, expect FAIL** — `cd src-tauri && cargo test transfers::io`.

- [ ] **Step 3: Implement.** SFTP open for append: `open_with_flags(part, OpenFlags::WRITE | OpenFlags::CREATE)` then `seek(SeekFrom::Start(offset))`; truncate case: `OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE`. SFTP source: `open` then `seek`. `stat` for SFTP uses `metadata().len()` and `mtime` (seconds, 0 if absent); local uses `std::fs::Metadata::modified()` as seconds.

- [ ] **Step 4: Run, expect PASS** — `cd src-tauri && cargo test transfers::io`.

- [ ] **Step 5: Commit** — `feat(transfers): part files, resume and safe finish`.

---

### Task 5: Transfer manager, commands, connections

**Files:**
- Create: `src-tauri/src/transfers/manager.rs`
- Modify: `src-tauri/src/sftp.rs` (extract the body of `sftp_connect_saved` into `pub async fn connect_saved_session(app: &tauri::AppHandle, session_id: String, host_id: String, username: Option<String>) -> Result<SftpConnectResult, String>` that reads its states via `app.state::<T>()`; the command calls it; add `pub fn session_info(&self, id: &str) -> Option<(Option<String>, String, u16, String, Arc<RusshSftp>)>` and `pub fn find_matching(&self, host: &HostRef, prefer: Option<&str>) -> Option<(String, Arc<RusshSftp>)>` on `SftpSessions`, skipping sessions whose `ssh_handle` is closed)
- Modify: `src-tauri/src/lib.rs` (manage `TransferManager` in `setup` right after the `LocalDb` is managed; register commands; `wipe_local_data` calls `transfers.wipe()` before `db::wipe_all`)

**Interfaces:**
- Consumes: Tasks 1–4; `CryptoState.session.lock().unlocked`; `SftpSessions`.
- Produces (Tauri commands, camelCase args):
  - `transfer_enqueue(jobs: Vec<NewJob>) -> Result<Vec<TransferJob>, String>` where `#[serde(rename_all="camelCase")] struct NewJob { kind: JobKind, src_path: String, dest_path: String, src_session_id: Option<String>, dest_session_id: Option<String>, replace: bool }`. Rust builds each `HostRef` from the session (`session_info`), stats the source for `src_size`/`src_mtime` (error → `Err` for the whole call, message names the file), assigns a uuid id, `part_path`, `created_at`, saves, emits.
  - `transfer_list() -> Vec<TransferJob>`, `transfer_pause(id)`, `transfer_resume(id)`, `transfer_resume_all()`, `transfer_cancel(id)`, `transfer_retry(id)`, `transfer_clear_finished()` — each `Result<(), String>`.
  - Event `transfers://changed` with payload `Vec<TransferJob>` (changed jobs only; a removed job is sent with its final status before removal).
  - `TransferManager::wipe(&self)` — stops every token, `forget_all`, `clear_jobs`.
- Behaviour to build (one background loop task, started in `new`):
  - Loop waits on a `tokio::sync::Notify` or a 1 s tick only while any job is `queued`/`active`/`waiting` (idle = no tick). Each pass: `due(now)`; wake `Unlock` waiters when `unlocked`; wake `Host` waiters when `find_matching` succeeds; close manager-owned sessions (`transfers:` prefix) unused for 30 s; start `startable()` jobs.
  - Starting a job: per remote side, `acquire`: `find_matching(host, prefer = the session id it was queued from, kept in memory only)`; else if `host_id` is Some: locked → `set_waiting(Unlock)`; else `connect_saved_session(app, "transfers:<host_id>:<username>", …)` (a prompt-cancel error → `Operation`, other connect errors → `Connection`); else (quick-connect) → `set_waiting(Host)`.
  - Run: `stat` source → offset = server copy ? 0 : `resume_offset(part_len, snapshot, now_stat)` → `copy` → `finish` → `Queue::finish`. Progress emits at most every 250 ms per job (with `speed`), progress saves at most every 5 s; status changes save + emit at once.
  - Pause/cancel: cancel the job's token at once and update the queue before the task returns; cancel also `remove_part` (local now; remote via `find_matching`, best effort, spawned).
  - A connection error drops the matching session from `SftpSessions` only if its handle is closed (never closes a pane's healthy session).

- [ ] **Step 1: Write the failing tests** (`manager.rs`, pure helpers kept out of the async glue):

```rust
#[test] fn new_job_from_download_has_remote_src_and_local_dest() // build_job(NewJob{kind: Download,…}, src_host: Some(h), dest_host: None, (100, 7), now) → src.host Some, dest.host None, part_path ends ".part", status Queued
#[test] fn server_copy_offset_is_always_zero() // offset_for(JobKind::ServerCopy, Some(40), s, s) == 0
#[test] fn upload_offset_uses_resume_rule() // offset_for(Upload, Some(40), s, s) == 40
#[test] fn connect_error_classification() // connect_error_class("<the cancel message SshHandler returns>") == Operation; "Connection refused" == Connection
#[test] fn progress_throttle() // Throttle::new(250).ready(0)==true, ready(100)==false, ready(250)==true
```
Expose `fn build_job(new: &NewJob, src_host: Option<HostRef>, dest_host: Option<HostRef>, snapshot: (u64, i64), now: i64) -> TransferJob`, `fn offset_for(kind: JobKind, part_len: Option<u64>, snapshot: (u64, i64), now: (u64, i64)) -> u64`, `fn connect_error_class(msg: &str) -> ErrorClass`, `struct Throttle`. Find the exact prompt-cancel message in `src-tauri/src/ssh.rs`/`ssh_auth.rs` and use it as a shared `const`.

- [ ] **Step 2: Run, expect FAIL** — `cd src-tauri && cargo test transfers::manager`.

- [ ] **Step 3: Implement the helpers, the manager, the `sftp.rs` extraction, and the `lib.rs` wiring.**

- [ ] **Step 4: Run, expect PASS** — `cd src-tauri && cargo test transfers` then `cd src-tauri && cargo test` (whole crate; `sftp_connect_saved` must still behave the same) and `cd src-tauri && cargo clippy --all-targets -- -D warnings` if the repo's CI runs clippy (check `.github/workflows`).

- [ ] **Step 5: Commit** — `feat(transfers): background transfer manager with retries and reconnects`.

---

### Task 6: Web — enqueue, mirror, remove old path

**Files:**
- Create: `src/lib/sftp/transfers.ts`
- Modify: `src/lib/sftp/fileTransfer.ts`, `src/lib/sftp/remoteFs.ts`, `src/stores/sftp/sftpStore.ts`, `src/App.tsx`
- Modify: `src-tauri/src/sftp.rs`, `src-tauri/src/lib.rs` (delete `sftp_download`, `sftp_upload`, `sftp_server_copy`, `sftp_cancel_transfer`, `SftpTransferProgress`, `cancel_tokens` if unused)
- Test: `src/lib/sftp/fileTransfer.test.ts`, `src/stores/sftp/sftpStore.test.ts` (new), `src/lib/sftp/remoteFs.test.ts` (drop tests of removed methods)

**Interfaces:**
- Consumes: Task 5 commands/event.
- Produces:
  - `transfers.ts`: `type TransferJob` (camelCase mirror of Rust), `type NewJob`, `enqueueTransfers(jobs: NewJob[]): Promise<TransferJob[]>`, `listTransfers()`, `pauseTransfer(id)`, `resumeTransfer(id)`, `resumeAllTransfers()`, `cancelTransfer(id)`, `retryTransfer(id)`, `clearFinishedTransfers()`, `onTransfersChanged(cb: (jobs: TransferJob[]) => void): Promise<UnlistenFn>`.
  - `sftpStore`: `transfers: TransferJob[]` (replaces `TransferItem[]`; `TransferItem`, `addTransfer`, `updateTransfer`, `removeTransfer` removed), `ensureTransferListener()` (loads `listTransfers()` once, subscribes, upserts by id, drops ids whose status went `done`/`cancelled` only on `clearCompletedTransfers`), `clearCompletedTransfers()` (calls `clearFinishedTransfers`, removes done/cancelled locally). On the first load, if any job is `paused`: `toast("N transfers paused", { action: { label: "Resume all", onClick: resumeAllTransfers } })` (singular "1 transfer paused").
  - `fileTransfer.ts`: `FileProvider` loses `upload`/`download`/`serverCopy`; `TransferPathEntry` gains `replace: boolean` (true when the entry or its root folder had a `replace` override); `TransferFileResult.action` gains `"waiting"`; `transferFiles` sends all remote jobs in one `enqueueTransfers` call (kind: remote→local `download`, local→remote `upload`, remote→remote `serverCopy`; session ids from `getSessionId()`), then awaits `waitForSettled(ids)`: resolves when each id is `done` (→ `copied`), `failed`/`cancelled` (→ error), `paused` or `waiting` with `waitReason` `host`/`unlock` (→ `waiting`). Local→local copies and local moves stay as today, without transfer rows. Summary toast adds `"N waiting"` when any.
  - `App.tsx`: call `useSftpStore.getState().ensureTransferListener()` once the app is unlocked.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/sftp/transfers`):

```ts
it("enqueues every remote file in one call with replace flags") // 2 files, one with replace override → enqueueTransfers called once with [{kind:"download", replace:true,…},{…replace:false}]
it("resolves when jobs finish") // emit done for both ids → results action "copied"
it("resolves_when_job_paused") // emit paused → result action "waiting"
it("treats_host_wait_as_handed_off") // waiting + waitReason "host" → resolves; waiting + "retry" does not
it("reports failed jobs as errors") // failed with error "denied" → result.error "denied"
// sftpStore.test.ts
it("mirrors changed jobs by id")
it("shows one paused toast with Resume all on first load")
it("clearCompletedTransfers keeps unfinished jobs")
```

- [ ] **Step 2: Run, expect FAIL** — `bunx vitest run src/lib/sftp/fileTransfer.test.ts src/stores/sftp/sftpStore.test.ts`.

- [ ] **Step 3: Implement; delete the old Rust commands and their registrations.**

- [ ] **Step 4: Run, expect PASS** — `bunx vitest run`, `bunx tsc --noEmit`, `cd src-tauri && cargo test`.

- [ ] **Step 5: Commit** — `feat(transfers): web layer enqueues to the transfer manager`.

---

### Task 7: Transfers panel

**Files:**
- Modify: `src/components/sftp/transfer/FileTransfer.tsx`
- Test: `src/components/sftp/transfer/FileTransfer.test.tsx` (new)

**Interfaces:**
- Consumes: `sftpStore.transfers: TransferJob[]`, `transfers.ts` actions.
- Produces: row label per status (Global Constraints copy; host label = `src/dest host.host`), file name = basename of the dest path, direction icon from `kind` (download / upload / copy), buttons: Pause (queued, active, waiting), Resume (paused), Retry (failed), Cancel (any not done/cancelled); header "Resume all" when any paused; "Clear done (N)" stays (done + cancelled). Retry countdown re-renders each second while any job is waiting on a retry.

- [ ] **Step 1: Write the failing tests:**

```tsx
it("shows the retry countdown") // waiting/retry, attempt 2, nextRetryAt now+8000 → "Retrying in 8 s (2 of 5)"
it("shows waiting for unlock and for host") // → "Waiting for unlock", "Waiting for example.com"
it("shows per-status buttons") // paused → Resume + Cancel; failed → Retry + Cancel; active → Pause + Cancel; done → none
it("Resume all appears only with a paused job and calls resumeAllTransfers")
it("Cancel calls cancelTransfer")
```

- [ ] **Step 2: Run, expect FAIL** — `bunx vitest run src/components/sftp/transfer/FileTransfer.test.tsx`.

- [ ] **Step 3: Implement**, reusing the existing row layout, `formatSpeed`, `formatBytes`, `Button` and phosphor icons (`PauseIcon`, `PlayIcon`, `ArrowClockwiseIcon`).

- [ ] **Step 4: Run, expect PASS** — `bunx vitest run`, `bunx tsc --noEmit`, `bunx biome check <touched files>`.

- [ ] **Step 5: Commit** — `feat(transfers): pause, resume, retry and status labels in the panel`.

- [ ] **Step 6: Manual check (record result in the ledger):** `bun run tauri dev`; download and upload a large file to a test host, drop the network mid-way (e.g. `nmcli networking off`, back on), watch "Retrying…" then completion and correct size; quit mid-transfer, reopen, unlock, toast → Resume all, check the final file. If no test host is reachable, ledger that the manual check was skipped.
