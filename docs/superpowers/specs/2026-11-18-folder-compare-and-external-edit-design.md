# Folder compare + edit in your own app: design

Date: 2026-11-18 · Size: project (client only, no server change) · Status: draft for approval

## Intent

This is files phase project 2 of the Termius/termoso parity work. The gap analysis lists it as
"Folder compare / watch-and-upload (M, med)". It has two features:

1. **Folder compare.** Put two folders side by side: local and remote, or two remotes. See what
   is new, changed or missing, and copy across in either direction.
2. **Edit in your own app.** Open a remote file in VS Code (or any desktop app). Every time you
   save it, Shetu uploads it back. This is the "watch-and-upload" the user chose. A folder kept
   continuously in sync is out of scope.

Both build on the merged transfer queue (`src-tauri/src/transfers/`). Every copy and upload goes
through it, so progress, resume, retries and the Transfers panel come for free.

## Decided (by the user)

- **"Watch-and-upload" means edit in your own app (A).** Continuous folder sync (B) is not part of
  this project.
- **Conflict on save: ask first.** If the server copy changed since the file was opened (or since
  Shetu last uploaded it), a save doesn't upload silently. Shetu asks:
  - **Overwrite server**: upload mine.
  - **Keep server's**: download the server copy over my local copy; the editor reloads.
  - **Save mine as a copy**: upload as `name (copy).ext`.
  - Saves without a conflict upload silently.
- **Sync never deletes.** Compare's Sync and copy actions only copy new and changed files. Files
  that exist only on the other side are listed, and the user can delete them by hand.
- **Copies keep the source's modified time (after the builder check).** Every transfer —
  download, upload and server copy — sets the copied file's modified time to the source's,
  like `scp -p` or `rsync -t`. Without it, every file Sync copies would show as "changed" again,
  and Sync would never settle.
- **Unsent edits (after the builder check).** Your latest save may not be on the server yet: a
  conflict is waiting for your answer, or the upload is queued or failed.
  - **Stop** asks: **Upload now** / **Discard** / **Keep editing**.
  - **Quitting** never deletes an unsent copy. On the next launch it shows under Editing remotely
    as "Not uploaded", with **Upload** and **Discard**.
  - **Sign-out** still wipes everything, unsent copies included, like all other local data.
- **Approach: my picks.**
  - Compare runs in the web layer, reusing the panes' existing recursive listing plus a small,
    tested diff function.
  - Edit-in-own-app uses a Rust file watcher (`notify` crate, a new standard dependency) next to
    the transfer queue, uploading through it.

## Goals / non-goals

- **Goals:**
  - the compare view with per-row and batch copy and "Sync →" / "← Sync";
  - "Open in default app" and "Open with…" for remote files;
  - auto-upload on save with conflict asking;
  - an "Editing remotely" list with Stop.
- **Non-goals:**
  - continuous folder sync;
  - content (checksum) comparison;
  - deleting during sync;
  - comparing more than two folders;
  - editing remote folders;
  - three-way merge;
  - S3/WebDAV (projects 3–4).
- **Anti-goals:**
  - never overwrite a server file someone else changed without asking;
  - never upload a half-written save (editors that write in several steps);
  - temp copies never outlive sign-out;
  - compare never changes anything until the user clicks copy or sync.

## Constraints

- **Panes** are a split tree (`SftpPaneNode` in `src/stores/sftp/sftpStore.ts`). Each leaf is a
  local or host pane, and host panes carry an SFTP session id.
- **Recursive listing** already exists on both providers: `listFilesRecursive` in
  `src/lib/sftp/remoteFs.ts` and `LocalFileProvider`. So does `resolveTransferPaths` and the
  queue's `transferFiles` (`src/lib/sftp/fileTransfer.ts`).
- **The remote file context menu** is built in
  `src/components/sftp/browser/shared/buildContextMenuItems.tsx`.
- **Opening files in other apps:** `tauri-plugin-opener` is already a dependency
  (`openPath(path, with?)`).
- **The transfer queue:**
  - Upload jobs go through `transfer_enqueue` with `destSessionId` and `replace`, and its single
    owner (`actor.rs`) emits `transfers://changed`.
  - Publishing an upload with `replace=true` removes the target and then renames, which is not
    atomic.
- **SFTP times:** remote modified times are whole seconds.

## Approaches

1. **Chosen:** web-layer compare plus a Rust watcher (`notify`).
   - Compare reuses the panes' listing and the queue; the diff is a pure TypeScript function.
   - The watcher lives in Rust next to the queue, so it survives a webview reload the same way
     transfers do.
2. **Web-layer compare plus polling the temp file's modified time from the web side.** No new
   dependency, but it misses saves during a reload and polls every open file.
3. **Rust compare command plus Rust watcher.** Faster on huge trees, but it duplicates listing
   code that already exists for both sides.

## Design

### Folder compare (web)

- **Entry point:** a **Compare** button in a pane's toolbar.
  - With exactly two panes open, it compares those two.
  - With more than two, a small picker asks "compare with…", listing the other panes by name and
    path. (My call.)
  - With one pane, the button is disabled, with a tooltip: "Open a second pane to compare".
- **Scan:** both panes' current folders, recursively.
  - **Remote panes** use their provider's `listFilesRecursive`.
  - **Local panes** use a new small Rust command, `local_list_recursive(path, cap)`, that returns
    each entry's relative path, kind, size and modified time. The existing local recursive
    listing skips file details: it reports size 0 and "now" for every file. (My call, after the
    builder check. Only the listing moves to Rust; the compare logic stays in TypeScript.)
  - The cap is 20,000 entries per side; past it, the user sees "Too many files to compare; pick a
    smaller folder". (My call.)
  - A spinner shows with a Cancel button. Cancelling discards the result.
- **Diff (`src/lib/sftp/compareFolders.ts`, pure):**
  - Paths are matched relative to each root, normalised to `/`.
  - Each path gets one status:
    - `onlyLeft`;
    - `onlyRight`;
    - `differs`: the sizes differ, or the modified times differ by more than 2 s;
    - `same`.
  - A path that is a folder on one side and a file on the other is `conflict` and is never
    copied; the user sees "different types". (My call.)
  - Folders are not rows of their own; they appear through their files. Empty folders only on
    one side show as `onlyLeft`/`onlyRight` folder rows.
  - Name matching is case-sensitive. (My call; servers are case-sensitive, and on
    case-insensitive local systems this can show two rows. Documented.)
- **View:** a panel or dialog over the two panes. (Builder's call; a full-width overlay is the
  suggestion.)
  - Each row shows the relative path, a status badge (`+` only left, `−` only right, `≠`
    differs), size and modified time on each side, and arrow buttons: **→** for onlyLeft and
    differs, **←** for onlyRight and differs.
  - "Show identical (N)" is off by default.
  - Rows can be multi-selected, with **Copy selected →** and **← Copy selected**.
  - **Sync →** copies every onlyLeft and differs row to the right. **← Sync** does the mirror.
  - Neither deletes. Rows only on the target show a **Delete** action that asks for confirmation
    first, using the panes' existing delete.
- **Copying:**
  - Copies go through the existing `transferFiles` and queue path, file by file, keeping relative
    paths. Missing target folders are created first; `mkdirAll` already exists.
  - Overwriting a `differs` file is the explicit choice the user made by clicking the arrow, so
    those jobs are queued with `replace = true`.
  - When the copies finish, the view rescans. There is also a **Rescan** button.

### Transfers keep modified times (Rust, `transfers/io.rs`)

- Before publishing, `io::finish` sets the `.part` file's modified time (and access time) to the
  source's modified time from the job's snapshot, so the rename keeps it:
  - **Local:** `std::fs::File::set_modified` / `set_times`.
  - **SFTP:** `setstat` with atime and mtime, through russh-sftp `set_metadata`.
- Server copies use the same step.
- If setting the time fails (some servers refuse `setstat`), the transfer still succeeds and the
  failure is logged. Compare then shows that file as `differs`; that is acceptable, so no error
  is raised.
- Tests:
  - a local copy keeps the source's mtime;
  - a refused set doesn't fail the publish.

### Uploads that must not overwrite a changed server copy (Rust, transfer queue)

- `TransferJob` gains `expect_dest: Option<(u64, i64)>`, with a serde default of `None`, so rows
  saved by older versions still load.
- When it is set, the worker stats the destination right before publishing:
  - If it is missing or no longer matches (size, mtime in seconds), the job fails with
    `Operation("conflict: the server copy changed")` and nothing is overwritten.
  - Otherwise publishing goes ahead as now.
- Edit uploads always set it to the edit's baseline, so the "ask first" rule holds even when the
  upload waited in the queue. (My call, after the builder check.)

### Edit in your own app (Rust watcher + web UI)

**Rust: new module `src-tauri/src/edits/` (or `transfers/edits.rs`; builder's call).**

- **State:** one owner, like the transfer actor. It keeps a map of edits:
  `edit_id → { session_id, host ref, remote path, local temp path, baseline (size, mtime),
  pending conflict }`.
- **Temp copies:** a per-edit folder under the app cache dir (`<cache>/remote-edits/<edit_id>/`)
  with the original file name, so editors show the right name and syntax. The folder is created
  owner-only (0700). The download is direct (`io::copy`), not queued: opening must be instant,
  and it's a single small file.
- **Commands:**
  - `edit_open(session_id, remote_path, app: Option<String>) -> EditView`. It stats the remote
    file, downloads it, records the baseline, starts watching, and opens it with
    `tauri-plugin-opener` (the default app, or the given app).
    - Files over 50 MB are refused until the call passes `confirm_large: true`; the web side asks
      first. (My call.)
    - If the same session and path are already being edited, the existing copy is reused and
      re-opened; no new download.
  - `edit_list()`.
  - `edit_stop(edit_id)`: stop watching and delete the temp folder.
  - `edit_resolve(edit_id, choice)` with choice `Overwrite`, `KeepServer` or `SaveAsCopy`.
- **Watching:**
  - Uses `notify` on the temp file's parent folder, because editors often save by writing a new
    file and renaming it over the old one.
  - Events are debounced 1 s after the last change, and a save is only acted on when size and
    modified time are stable across two checks 250 ms apart. That's the "half-written save"
    guard. (My call on the numbers.)
- **On a save:**
  1. Stat the remote file.
  2. If it matches the baseline, enqueue an upload: the local temp file goes to the remote path,
     `replace = true`, `expect_dest = baseline`, through the transfer queue. Enqueuing is internal:
     the edit stores its `HostRef`, so the queue's own reconnect can carry it even after a
     restart or with the pane closed. The `HostRef` is still taken from the session when the edit
     opens.
  3. If it doesn't match, record a pending conflict and emit `edits://conflict` (edit id, remote
     size and time); don't upload. Further saves while a conflict is pending only update the
     pending state.
- **After an upload finishes (job Done):** because copies keep their times, the new baseline is
  the uploaded local file's own (size, mtime), so no racy re-stat of the server is needed.
  - A job that fails with the conflict error becomes a pending conflict, with the dialog.
  - Any other failure shows in the Transfers panel; the edit stays active, still "unsent", and
    the next save or **Upload** tries again.
  - Builder's call on how the edit owner learns of its jobs' outcome, for example a
    job-finished notification from the transfer loop for job ids it holds.
- **Unsent state:** an edit is *unsent* while its latest save hasn't been published, which covers
  a pending conflict, a queued upload and a failed one. The edit list (session/host, remote path,
  temp path, baseline, unsent flag) is saved in `<cache>/remote-edits/edits.json`, so unsent edits
  survive a restart.
- **Resolving a conflict:**
  - **Overwrite:** upload now; the baseline is the post-upload stat.
  - **KeepServer:** download the server copy over the temp file; the editor sees it change and
    reloads; the baseline becomes the server's.
  - **SaveAsCopy:** upload to `name (copy).ext` through the queue with `replace = false`, so the
    queue's free-name rule applies. The baseline is unchanged, and the next save will conflict
    again until the user picks Overwrite or KeepServer.
- **Stopping an edit:**
  - **Stop:** `edit_stop` with nothing unsent stops and deletes. With something unsent, the web
    side asks Upload now / Discard / Keep editing first; `edit_stop(id, discard: true)` deletes
    regardless.
  - **Pane close:** stops watching.
  - **Sign-out:** the wipe stops all edits and deletes `<cache>/remote-edits/`, unsent included.
  - **Quit:** watching ends, but unsent copies stay.
  - **Startup:** deletes temp folders with nothing unsent. Unsent ones are listed as "Not
    uploaded" (not watched until reopened), with **Upload** (queues it with its saved
    baseline, so a server change still asks) and **Discard**.
- **Events:** `edits://changed` with the list, so the UI mirrors it like the transfer list.

**Web:**

- **Context menu** in `buildContextMenuItems.tsx`, for remote files only:
  - **Open in default app**;
  - **Open with…**: a file picker for an application, remembered per file extension in settings,
    with "Choose another app…" available later. (My call.)
- **"Editing remotely" section** in the Transfers panel area. Each row shows the file name,
  host, path and status (Watching, "Uploading…", or "Conflict: server copy changed"), with
  **Open again** and **Stop** buttons. It mirrors `edits://changed`.
- **Conflict dialog** on `edits://conflict`:
  - Text: "nginx.conf changed on web-01 since you opened it."
  - Buttons: **Overwrite server**, **Keep server's version**, **Save mine as a copy**.
  - Dismissing it leaves the conflict pending, and the row shows "Conflict" with a **Resolve**
    button that reopens the dialog.

### Tests

- **`compareFolders`:**
  - each status;
  - the 2 s time tolerance;
  - nested paths;
  - a folder on one side and a file on the other;
  - an empty folder only on one side;
  - Windows `\` paths normalised;
  - the cap.
- **Compare view:**
  - row arrows by status;
  - Sync → queues exactly the onlyLeft and differs rows, with `replace` only for differs;
  - "Show identical" toggle;
  - Delete asks for confirmation and is only on target-only rows;
  - rescan after copies finish.
- **Rust transfer changes:**
  - modified time kept on local and SFTP publish;
  - `expect_dest` mismatch fails without overwriting;
  - `None` behaves as before;
  - old saved rows without the field still load.
- **`local_list_recursive`:** sizes and times present; cap respected.
- **Rust edit owner, as a pure state machine like `actor.rs`:**
  - open, then save with an unchanged baseline: upload;
  - save after the remote changed: conflict, no upload;
  - saves while a conflict is pending: still no upload;
  - Overwrite, KeepServer and SaveAsCopy outcomes and their baselines;
  - Stop and wipe remove temp folders;
  - re-open reuses the edit;
  - debounce and stability (a two-step save uploads once);
  - the over-50 MB refusal without confirmation;
  - unsent tracking: a failed or conflicting upload stays unsent;
  - Stop with unsent needs discard;
  - restart restore lists unsent edits and drops sent ones.
- **Web:** menu items only on remote files; the conflict dialog's buttons call `edit_resolve`
  with the right choice; the Editing list mirrors events.
- **Manual check:** edit a remote file in VS Code and save twice. Change it on the server, save
  again, and see the conflict dialog. Then run a compare of a local and a remote folder, and
  Sync →.

## Security notes

- Temp copies sit in an owner-only folder in the app cache and are deleted on Stop, sign-out,
  quit and the next startup. Files from a server never land in the user's own folders unless
  they choose to save them there.
- Uploads go only to the exact remote path and session they came from (or `name (copy)` on
  SaveAsCopy), through the queue's existing endpoint checks.
- "Open with…" launches only an app the user picked themselves.

## Left to the builder

- Where the compare view sits and its layout.
- The module location for the edit owner and how it learns that an upload finished.
- The exact `notify` configuration per OS.
- The settings key for the per-extension app choice.
- Wording.

## Calls made without asking

- Compare between any two panes, including two remotes; with more than two panes, a "compare
  with…" picker.
- "Different" means a size difference or a modified-time difference over 2 s; no content
  comparison.
- The 20,000-entries-per-side cap.
- A folder/file type clash is shown, never copied.
- Name matching is case-sensitive.
- Differs-row copies overwrite (`replace = true`), because the arrow is an explicit choice.
- Delete for target-only rows asks for confirmation each time.
- The edit download is direct, not queued; uploads are queued.
- A 1 s debounce plus a stability check.
- The 50 MB confirmation.
- Re-opening reuses the edit.
- Only unsent edits survive a restart (as "Not uploaded"). Temp copies are deleted on Stop
  and sign-out; at startup only folders with nothing unsent (and unchanged on disk) are
  deleted; quitting deletes nothing. If the saved list can't be read, nothing is deleted.
- "Open with…" remembers the app per extension.
- SaveAsCopy leaves the baseline unchanged, so the next save asks again.
- After the builder check:
  - local folders are listed by a small Rust command (sizes and times); the compare logic stays
    in TypeScript;
  - edit uploads carry `expect_dest`, so the server check happens at publish time, not only at
    save time;
  - a failure to set the modified time is logged, not fatal;
  - the post-upload baseline comes from the local file, not a re-stat.
