# Resumable transfers + saved queue: design

Date: 2026-11-18 · Size: project (client only, no server change) · Status: draft for approval

## Intent

Today a dropped connection, a closed tab or an app restart loses a transfer. The partly written
file sits under its real name, looking complete, and the user has to start again from zero. The
queue lives only in memory. This project makes transfers survive all three. Files are written
safely and resume where they stopped, a drop retries on its own, and an unfinished queue comes
back after a restart. Gap analysis "D. Files": "Transfer resume + persistent queue (M, high)".

This is project 1 of the files phase. The order is:

1. resumable transfers (this project);
2. folder compare / watch-and-upload;
3. S3-compatible buckets;
4. WebDAV.

Projects 2–4 reuse the transfer engine built here.

## Decided (by the user)

- **Safe writes.** Downloads and uploads write to `<name>.part` and rename it to the real name
  once complete. A half-done file never sits under the real name.
- **Resume.**
  - A resumed transfer continues from the `.part` file's size.
  - It restarts from zero if the source's size or modified time changed since the transfer was
    queued.
- **Connection drops.**
  - The transfer retries by itself up to 5 times, waiting 2 s, then longer each time, up to 60 s.
  - After that it shows Failed with a Retry button.
- **After an app restart.** Unfinished transfers show as Paused, with Resume per row and
  Resume all.
- **Queue storage.** The queue is saved on this device only and is not synced.
- **Controls.**
  - Each row has Pause, Resume, Cancel and Retry.
  - Cancel deletes the `.part` file.
  - 3 transfers run at a time.
- **Quick-connect hosts** (not saved): their transfers resume once that host is connected again.
- **Server-to-server copies** restart from zero instead of resuming.
- **Approach: a transfer manager in Rust.**
  - Rust owns the queue, the 3-at-a-time limit, retries, reconnects, pause/resume and the saved
    queue. The web UI only shows that state and sends commands.
  - Transfers keep running through a window reload.
  - The S3, WebDAV and watch-and-upload projects plug into the same engine later.

## Goals / non-goals

- **Goals:**
  - `.part` writes and resume for SFTP downloads and uploads;
  - `.part` writes for server-to-server copies;
  - auto-retry with reconnect;
  - the saved queue and its restore after a restart;
  - per-row controls and Resume all;
  - the Transfers panel shows the new states.
- **Non-goals:**
  - S3, WebDAV, folder compare and watch-and-upload (projects 2–4);
  - checksum verification (SFTP has no standard hash command);
  - bandwidth limits and scheduling;
  - syncing the queue to other devices;
  - several parallel streams for one file;
  - resuming server-to-server copies;
  - queueing local→local copies and local moves (they stay instant, as today);
  - changing what a cross-pane "move" does.
- **Anti-goals:**
  - never leave a partial file under the real name;
  - never resume onto a source that changed;
  - never write over a destination the user didn't approve (conflicts are still resolved before
    queueing, as today);
  - one stuck transfer never blocks the others;
  - the saved queue never holds passwords or keys;
  - a transfer that can't run (offline, host gone) never spins the CPU or floods the logs.

## Constraints

- **SFTP connections live in Rust** (`src-tauri/src/sftp.rs`): `SftpSessions`, keyed by session id
  (today, one per file-browser pane). Each session records `host_id` (saved hosts), host, port and
  username.
- **Sign-in prompts work for any session.** `AuthPromptDialog` and `HostKeyDialog` are mounted
  once in `App.tsx` and listen to every session. A connection the manager opens in the background
  still shows the normal password, one-time-code and host-key dialogs.
- **Saved hosts need unlocked credentials.** `ssh_route::resolve_saved_route_as` decrypts them, so
  while the app is locked a saved host can't be reconnected. Open connections keep working while
  locked (`lock_session` clears only the crypto state).
- **Local storage:** SQLite `shetu.db` (`db::LocalDb`). Sign-out and device wipes clear it through
  `db::wipe_all`, which lists every table.
- **Today's transfer path, all of which this project replaces:**
  - `sftp_download`, `sftp_upload`, `sftp_server_copy` and `sftp_cancel_transfer`;
  - the `sftp-transfer-progress` event;
  - the `FileProvider.upload/download/serverCopy` methods in `src/lib/sftp/remoteFs.ts`;
  - batches of 3 in `transferFiles` (`src/lib/sftp/fileTransfer.ts`);
  - the in-memory `transfers` list in `src/stores/sftp/sftpStore.ts`;
  - the panel in `src/components/sftp/transfer/FileTransfer.tsx`.
  - Only `fileTransfer.ts` calls these.
- `russh-sftp` 2.4 is already a dependency; no new crates.

## Approaches

1. **Rust transfer manager (chosen).**
   - One engine owns the queue, retries, reconnects and the saved queue.
   - It survives webview reloads.
   - Projects 2–4 add a backend instead of rebuilding resume and retry.
   - Cost: a bigger first project; the web queue logic moves to Rust.
2. **Extend the web queue.**
   - Smaller now.
   - But each later backend would need its own resume and retry code, and a reload cuts off
     transfers in progress.
3. **Libraries considered:**
   - Apache OpenDAL is the plan for S3 and WebDAV in projects 3–4. It isn't used for SFTP: its
     SFTP support runs the system `ssh` program, bypassing the app's own sign-in, agent and
     jump-host handling.
   - `notify` is for project 2.
   - Nothing on the JS side, and no queue or retry library: the logic is small.

## Design

### Rust: `src-tauri/src/transfers.rs` (new), Tauri state `TransferManager`

- **Job** (what is saved and shown):
  - **identity and kind:** `id`, `kind` (`download` | `upload` | `server_copy`);
  - **source and dest:** each is a local path, or a remote endpoint `{host, path}`;
  - **host reference:** `{saved: host_id, username}` or `{quick: host, port, username}`. No
    secrets;
  - **source snapshot at queue time:** `size` and `mtime`;
  - **progress:** `status`, `transferred`, `attempt`, `next_retry_at`, `error`, `created_at`.
- **Statuses:**
  - `queued`, `active`, `paused`, `done`, `cancelled`;
  - `waiting`: for a connection, an unlock, or a retry delay; the row says which;
  - `failed`.
- **Commands:**
  - `transfer_enqueue(jobs, session_id)` returns the new ids. `session_id` is the pane the
    transfer was started from, used first for the connection.
  - `transfer_pause(id)`, `transfer_resume(id)`, `transfer_resume_all()`, `transfer_cancel(id)`,
    `transfer_retry(id)`.
  - `transfer_list()` returns all jobs.
  - `transfer_clear_finished()` removes done and cancelled rows.
- **Event:** `transfers://changed` carries the changed job(s).
  - Progress is throttled to about 4 updates per second per job.
  - Status changes go out at once.
  - It replaces `sftp-transfer-progress`.
- **Scheduler:**
  - At most 3 jobs `active`; the oldest queued job starts next.
  - A `waiting` job doesn't hold one of the 3 places.
- **The `.part` name is per job** (my call, after the builder check): `<name>.<first 8 chars of
  the job id>.part`, stored on the job. Only that job's own retries and resumes adopt it, so an old
  `.part` from an earlier send of a different version, or a user's own `report.pdf.part`, is never
  appended to or renamed away.
- **The source snapshot** (size, mtime) is taken by Rust with a stat at enqueue time, not
  trusted from the web layer (clipboard pastes send `size: 0`).
- **Destination decision is saved on the job** (my call): `new` (no conflict when queued) or
  `replace` (user approved replacing). Just before the final rename, Rust re-checks: a `new` job
  whose destination now exists finishes under the next free name (`name (1).ext`, the same rule
  `resolveTransferPaths` uses for auto-rename) instead of overwriting.
- **Safe write and resume, per kind:**
  - **Download:**
    - Write to the local `<dest>.part`.
    - On resume: if the `.part` file exists, the source size and mtime match the snapshot, and the
      `.part` is no bigger than the source, open the remote file, seek to the `.part` size and
      append. Otherwise truncate and start from zero.
    - When finished: rename `.part` to the destination, replacing it.
  - **Upload:** the same, with the `.part` file on the server.
    - Its size comes from a remote stat; the remote file is opened for writing without
      truncation, then seeked.
    - When finished: replace the destination with the `.part`. Use the `posix-rename@openssh.com`
      extension when the server offers it; otherwise remove the destination, then rename.
      (Builder's call on detection; `russh-sftp` 2.4 doesn't expose the extension list on
      `SftpSession`, so remove-then-rename is an acceptable only path. If the rename fails after
      the remove, the complete `.part` stays and the job fails with that message.)
    - Upload resume trusts the remote `.part` size: the SFTP protocol requires a server to apply
      requests on one file handle in the order received, so pipelined writes can't leave a hole
      (my call; no single-write throttling).
  - **Server copy:**
    - Write to the destination's `.part` and rename when finished.
    - On resume or retry, always start from zero.
  - **0-byte files** complete at once.
  - **Cancel** stops the job and deletes its `.part`: at once for local files; for remote files,
    whenever a connection to that host is available, best effort.
- **Connections:** to run a job, the manager needs an SFTP session for its host. In order:
  1. **The pane's session** the job was queued from, if it is still open and matches the host.
  2. **Any other open session** matching the host reference: the same `host_id` and username, or
     the same host, port and username for quick-connect hosts.
  3. **Saved hosts only: a session the manager opens itself.** It uses the same connect path as
     `sftp_connect_saved`, with its own session id (e.g. `transfers:<host_id>:<username>`).
     - Prompts appear through the normal dialogs.
     - If the user dismisses a prompt, the job fails with no more retries.
     - While the app is locked, the job waits ("Waiting for unlock") and continues after unlock.
     - The manager closes its own sessions once no job has needed them for about 30 s.
  4. **Quick-connect hosts:** the job waits ("Waiting for <host>") until a matching session
     appears, then continues.
     - This counts as neither an attempt nor a failure.
     - After a restart these jobs show Paused like every other unfinished job. Resume puts them
       into this waiting state.
- **Retries:**
  - **A connection error** (session closed, channel or I/O error, timeout) starts a retry: up to
    5, at 2 s, 4 s, 8 s, 16 s, 32 s (each capped at 60 s), with status `waiting` and the attempt
    number. Each attempt resumes from the `.part`.
  - **An operation error** (permission denied, no space, source missing, path is a folder) fails
    at once.
  - Builder's call on classifying errors. When unsure, treat it as a connection error.
- **Closing a pane during a transfer** closes that pane's session. The transfer treats that like a
  drop:
  - for saved hosts it moves on to a session the manager opens itself;
  - for quick-connect hosts it waits for a matching session.
- **Saved queue** (my call: a table in `shetu.db`, e.g. `transfer_jobs`, added to `wipe_all`):
  - every status change is saved;
  - progress is saved at most every few seconds; it is display only, since resume reads the
    `.part` size;
  - on startup, `queued`, `active` and `waiting` jobs load as `paused`; `failed` jobs stay failed;
  - `done` and `cancelled` rows are dropped on startup;
  - sign-out and device wipes cancel all running jobs and empty the table. Their `.part` files
    stay where they are.
- **Old commands:** `sftp_download`, `sftp_upload`, `sftp_server_copy` and
  `sftp_cancel_transfer` are removed once nothing calls them.

### Web

- **`transferFiles`** keeps the scanning, folder expansion, conflict resolution, `mkdirAll`,
  local→local copies and local moves.
  - It sends every remote job to `transfer_enqueue` in one call.
  - It then waits until each of those jobs is done, failed, cancelled, paused, or waiting for a
    host or an unlock (handed off: these can wait indefinitely), so existing callers, their toasts
    and their folder refreshes keep working. The summary toast counts handed-off jobs as
    "N waiting" (my call). A job waiting on a retry delay still counts as running.
  - Batching and its 3-at-a-time loop are removed: Rust does the limit.
- **`sftpStore`:**
  - `transfers` mirrors the manager: `transfer_list()` on start, then `transfers://changed`.
  - `TransferItem` gains the new statuses, `attempt`, `nextRetryAt` and a short wait reason.
  - The store-side add, update and remove calls for remote jobs go away.
- **Transfers panel** (`FileTransfer.tsx`):
  - **Row labels:** Queued, Transferring (progress and speed), Paused, "Retrying in 8 s
    (2 of 5)", "Waiting for unlock", "Waiting for <host>", Failed (message), Done.
  - **Buttons:** Pause (queued, active, waiting), Resume (paused), Retry (failed), Cancel (any
    unfinished row).
  - **Header:** "Resume all" whenever a row is paused. "Clear done" stays.
- **After a restart with paused jobs** (my call): one toast, "N transfers paused", with a Resume
  all action. Nothing starts until the user picks Resume.

### Tests

- **Rust:**
  - resume offset decision: `.part` missing, smaller, bigger than the source, source changed;
  - retry schedule and its cap;
  - error classification;
  - scheduler: 3 at a time, waiting jobs not counted, pause frees a place;
  - restart restore: statuses mapped, done rows dropped;
  - `wipe_all` covers the table;
  - a local download into `.part` that is resumed and renamed;
  - cancel deletes the local `.part`.
- **Web:**
  - `transferFiles` enqueues and resolves when jobs finish or pause;
  - the store mirrors events;
  - panel buttons per status, Resume all, the retry countdown label, the restart toast.
- **Manual check before review:** download and upload a large file, kill the network mid-way,
  watch it retry and finish; quit the app mid-transfer, reopen, Resume all, check the result.

## Security notes

- The saved queue holds paths and host references, never passwords or keys. It is cleared with
  the rest of the local data on sign-out and device wipes.
- Background reconnects use the same host-key checks and prompts as a normal connect. Nothing
  connects to a host whose key isn't trusted without asking.
- `.part` files live next to their destination with the same permissions a normal write gets.

## Left to the builder

- The internal split between the queue and the per-backend read/write code, shaped so S3 and
  WebDAV can be added later.
- The exact table layout.
- The event payload shape.
- How a progress write is throttled.
- The exact wording of messages.
- How a rename is detected and done on the server.
- Error classification details.

## Calls made without asking

- The manager may open its own connection to a saved host, prompting through the normal dialogs.
  A dismissed prompt fails the job.
- While locked, saved-host jobs wait for unlock instead of failing.
- Quick-connect jobs wait for a matching session, and that wait doesn't use up retries.
- Closing the pane a transfer was started from doesn't stop the transfer.
- Server copies also use `.part`.
- `done` and `cancelled` rows are not kept after a restart; failed rows are.
- Sign-out leaves `.part` files on disk (they belong to the user's folders), but empties the
  queue.
- After a restart, a single toast with Resume all; nothing resumes on its own.
- The queue is stored in `shetu.db`.
- After the builder check:
  - per-job `.part` names (`<name>.<id8>.part`); only the job itself adopts its `.part`;
  - Rust stats the source at enqueue for the snapshot;
  - a destination that appeared after queueing (with no approved replace) gets the next free name
    instead of being overwritten;
  - upload resume trusts the remote `.part` size (SFTP's in-order rule), no write throttling;
  - remove-then-rename is acceptable when `posix-rename` can't be detected;
  - `transferFiles` treats jobs waiting for a host or unlock as handed off; the toast says
    "N waiting".
