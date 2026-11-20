# S3 buckets as a file pane — design

Files project 3 of the termoso gap analysis (`docs/analysis/2026-11-14-termoso-gap-analysis.md`).

## Intent

Shetu's file panes show this computer or an SSH host. People also keep files in S3-compatible
buckets: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO. This adds
a third kind of pane, an **S3 bucket**. You can browse it, move files to and from it through
the existing transfer queue, and compare it with another pane, the same way as an SFTP pane.
termoso has this and Shetu doesn't; the goal is parity.

## Goals

- S3 accounts are saved encrypted, synced, and shareable in team vaults, like identities.
- A file pane can open an S3 bucket. In it you can list, open folders, create a folder,
  rename, delete, upload, download, and drag to or from any other pane.
- Transfers to and from a bucket go through the transfer queue, with the same rules as SFTP:
  pause and cancel, restart after a quit, the "ask before replacing a newer file" check, and
  progress.
- Folder compare works when one or both sides are a bucket.
- Presets for AWS S3, Cloudflare R2, Backblaze B2, Wasabi and DigitalOcean Spaces, plus
  Custom (any endpoint, such as MinIO).

## Non-goals (this project)

- "Edit in your own app" for objects, and "Open in Editor" (the in-app editor). Both menu
  items are hidden in bucket panes; the in-app editor only knows local and host
  (`editorStore.ts`, `editorProvider.ts`). *(My call: the in-app editor would be a sizeable
  extra slice, and it is the same kind of feature as the agreed non-goal.)* Previews of small
  files that remote panes already have keep working through `storage_read`.
- Resuming an interrupted **upload** to a bucket. An interrupted upload starts again from
  zero (agreed). Downloads from a bucket do resume.
- AWS profiles or SSO from `~/.aws`, IAM roles, session tokens. Only an access key and a
  secret key.
- Bucket administration: creating or deleting buckets, ACLs, lifecycle rules, versioning UI,
  presigned links.
- WebDAV and FTP. They come later on the same plumbing.
- Support for older servers. Nothing is published yet.

## Anti-goals

- Secrets in the webview. After a save, the secret key is never sent back to the web side
  (the same rule as identities' secrets).
- A bucket pane that looks like it works but loses data. For example, renaming a "folder"
  must not leave half the objects moved without saying so.
- SSH-only code paths seeing bucket accounts. They are not hosts.

## Decisions (from the conversation)

| Topic | Decision |
|---|---|
| Where accounts live | A new synced table, `storage_accounts`, on client and server. No old-server fallback. |
| Existing fallbacks | Remove the identities old-server fallback (`TABLES_OLD_SERVERS_REJECT`, `server_lacks_identities`). |
| Scope | Browse, transfer and compare. No edit-in-own-app. |
| Providers | Presets (AWS, R2, B2, Wasabi, Spaces) plus Custom. |
| Credentials | Access key and secret key only. |
| Upload resume | Not in this project: an interrupted upload restarts from zero. |
| Library | OpenDAL. |
| Unfinished multipart uploads | Abort the upload on cancel, pause and error. A quit or crash leaves parts behind; the account form advises the provider's "delete incomplete multipart uploads after N days" lifecycle rule. No restart-time sweep. |
| Newer-file check onto a bucket | Shetu saves the source file's own time in the object's user metadata (`mtime`, in seconds) when uploading, and the check reads it back. Objects uploaded elsewhere fall back to `LastModified`. |

## Approaches considered

- **A. OpenDAL in Rust, as a third storage side in the transfer engine.** Chosen. The
  engine's `Side` gains a variant holding an `opendal::Operator`, and bucket panes use new
  `storage_*` commands. WebDAV and FTP become cheap later, since they are just another
  `Operator`. Cost: one sizeable dependency, and no upload resume.
- **B. The official AWS SDK (`aws-sdk-s3`) with the same engine placement.** The fullest S3
  support, with a route to resumable uploads through our own multipart code. Rejected: a
  much heavier build, S3 only (WebDAV and FTP would each need another library and another
  side), and it needs per-provider checksum settings.
- **C. A JavaScript S3 client in the webview.** Dropped. Secrets would live in the webview,
  R2 and B2 block browser requests by default (CORS), and it would bypass the transfer queue
  and its rules.

## Design

### 1. The `storage_accounts` table (server and client)

The same layout as `identities`: sync metadata (`id, vault_id, revision, created_at,
updated_at, deleted_at, edited_at, device_id, operation_id`), readable `name` and
`sort_order`, and one encrypted `data` blob.

`data` is JSON, encrypted with the vault key the same way as other tables:

```json
{ "provider": "aws|r2|b2|wasabi|spaces|custom",
  "endpoint": "https://…",        // filled by the preset; editable only for custom
  "region": "us-east-1",
  "bucket": "my-bucket",          // optional; empty = list buckets
  "pathStyle": false,              // custom only (MinIO needs true)
  "accessKeyId": "…",
  "secretAccessKey": "…" }
```

- **Server:** an `models.StorageAccount` model mirroring `models.Identity`. Add it everywhere
  `identities` appears: AutoMigrate, the sync table list (`internal/sync/handlers.go`),
  validation, timestamps, team-key rotation (`internal/teams/rotation.go`) and purge.
- **Client:** add the table everywhere `identities` sync is wired. That means `db.rs`
  (`Table` enum, `parse`, `table_cols`, the table list), and in `sync_db.rs` the
  `expected_fields` and the pull list. Add it to any client-side team-key rotation that
  re-encrypts identities.
- Like identities, the blob is decrypted only in Rust. Commands return a **view** without
  the secret (`secretSaved: true`). Saving with an empty secret keeps the stored one.
- Remove the identities old-server fallback in the same project.

### 2. Accounts UI

- A **Storage** list sits next to Hosts, Keys and Identities, with add, edit and delete.
- The form has: provider preset, name, region, bucket (optional), access key, secret key,
  and for Custom also endpoint and path-style.
- **Preset endpoints:**

  | Preset | Endpoint |
  |---|---|
  | AWS | from the region |
  | R2 | `https://<account-id>.r2.cloudflarestorage.com`, region `auto`; the form asks for the account ID |
  | B2 | `https://s3.<region>.backblazeb2.com` |
  | Wasabi | `https://s3.<region>.wasabisys.com` |
  | Spaces | `https://<region>.digitaloceanspaces.com` |

- **Test connection:** lists one page of the bucket (or the buckets) and shows the result.

### 3. Bucket panes

- The pane connection picker gains **S3 bucket** next to Local and Host, and lists the
  accounts. The `connectionType` union gains `"storage"`.
- A bucket pane opens a Rust-side **storage session** keyed by pane id, the same way SFTP
  sessions are. Rust builds and caches the `Operator` for that account and bucket.
- If the account has no bucket, the pane first shows the account's buckets (ListBuckets) and
  opening one picks it. A key that isn't allowed to list buckets shows a plain error asking
  for a bucket in the account.
- A web-side `StorageFileProvider` implements `FileProvider` over new commands:
  `storage_connect`, `storage_disconnect`, `storage_list`, `storage_list_recursive` (with
  the same cap as compare), `storage_stat`, `storage_mkdir`, `storage_delete` (a folder
  deletes recursively after confirmation), `storage_rename`, `storage_read` and
  `storage_write` (small files only, for anything in the UI that already uses them on
  remote panes).
- **Folders:** S3 has only name prefixes.
  - "New folder" writes an empty `prefix/` marker object.
  - A listing shows common prefixes as folders.
  - Rename uses a server-side copy, then delete. For a folder it copies and deletes every
    object under the prefix, after a confirmation showing the count. If it stops partway,
    it reports how many objects moved, and the rest stay under the old name. It never
    deletes before the copy succeeds.
  - A single S3 copy is capped at 5 GiB. Rename checks every size first and refuses, with
    a plain message, if any object is larger. Nothing moves in that case. *(My call: the
    alternatives are copying through the client or writing a multipart copy ourselves.
    The first is slow and surprising; the second is extra S3 code for a rare case.)*
- Permissions, owner, chmod, chown and symlinks are hidden in bucket panes. Those menu
  items don't appear.

### 4. Transfer engine

- **Endpoint:** `Endpoint` gains `storage: Option<StorageRef>` (`account_id`, `bucket`),
  with a serde default, next to `host`. A storage endpoint has `host: None`.
  - Saved jobs stay readable.
  - `Endpoint` no longer means "local" when `host` is `None`; local becomes "no host and
    no storage".
- **Side:** `io::Side` gains `Remote(opendal::Operator)`. Every `match side` site gets a
  `Remote` arm:
  - **stat / stat_if_exists:** `op.stat`. Missing objects map to `None`. The size is the
    object's content length, and the mtime is `last_modified` in seconds.
  - **Reading** (download source): `op.reader_with(path)` reads from the offset, so
    downloads resume.
  - **Writing** (upload destination): uploads write the destination key **directly**
    (`op.writer_with`, with chunked multipart for large files). An S3 object appears only
    when the write completes, so no `.part` object is needed.
    - `part_len` for a remote destination is always 0, so an upload restarts from zero (the
      agreed limit).
    - Cancel, pause and a failed run abort the writer, which also aborts the multipart
      upload (best effort; a failed abort is logged).
    - A quit or crash leaves the parts behind (agreed). The account form shows a short note
      advising the provider's "delete incomplete multipart uploads after N days" lifecycle
      rule.
    - Each upload stores the source's mtime in user metadata (`mtime`, in seconds).
  - **finish** for a remote destination: the object is already in place. `finish` handles
    only the `replace=false` naming: pick a free name before writing, using the same
    `free_name` rule.
  - **Expected destination:**
    - `expect_dest` is checked with a stat just before the write. That is best effort, as it
      is for SFTP.
    - For `ABSENT`, the write uses `if_not_exists` when the operator reports that capability
      (AWS and R2 support conditional writes). Otherwise it falls back to stat-then-write,
      and the code comment says it's best effort.
  - **set_mtime:** a no-op. S3 sets `LastModified` itself; the source time travels in the
    `mtime` metadata written with the object.
  - **stat for a remote side** returns the `mtime` metadata when present, else
    `LastModified`. The newer-file check (`newerOnTarget`, the destination check) therefore
    compares real file times for objects Shetu uploaded. Objects uploaded elsewhere may warn
    once.
  - **discard_part / remove_part:** a no-op for a remote destination.
- **Resolving a side:** the worker's side resolver builds (or reuses) an `Operator` from the
  job's `StorageRef`. It decrypts the account in Rust, the same way the SFTP resolver
  reconnects a saved host.
  - A deleted account fails the job with a plain message.
  - Connection-type OpenDAL errors (`Unexpected`, temporary) map to
    `JobError::Connection`, so they get the existing backoff.
  - `NotFound`, `PermissionDenied`, `ConfigInvalid` and `RateLimited` (which retries) map
    to their natural classes.
- **The actor's `Held` and `Lookup`** hold SFTP sessions. A remote side needs no shared
  session limit, so either it bypasses that bookkeeping or that bookkeeping gains a variant.
  Left to the builder (see below).
- **The web transfer API** (`transferFiles`) accepts a storage pane as either end, the same
  as a host pane.

### 5. Folder compare

- `CompareSide.kind` gains `"storage"`. Listing goes through `storage_list_recursive`.
- With a bucket on either side, a pair counts as the same when the sizes match, and the
  times are shown for information only.
  - The recursive listing gives only `LastModified` (the upload time), not the `mtime`
    metadata, so comparing listed times would flag every copied file.
  - Before replacing, the newer-file prompt still runs per file through `stat`, which does
    read the `mtime` metadata (see section 4).
- Copy and delete from the compare view go through the transfer queue and `storage_delete`
  as usual.

### 6. Errors and security

- Secrets are decrypted only in Rust and never logged. The `Operator` is built in Rust.
- Errors shown to the user name the bucket and key, never the credentials.
- Sign-out (`wipe_local_data`) drops cached storage sessions along with the other wipes.

## Left to the builder

- OpenDAL version, cargo features (`services-s3`, plus `services-memory` for tests), chunk
  size and concurrency. R2 needs exact part sizes (`enable_exact_buf_write`).
- How the actor's held-session bookkeeping treats a remote side (bypass or new variant).
- The exact `storage_*` command list, trimmed to what `FileProvider` and the menus actually
  use for remote panes.
- Engine tests can use an OpenDAL **memory** operator as a stand-in for S3, so `Side::Remote`
  paths run in unit tests without a network.
- A manual test with a real bucket (MinIO locally, and one hosted provider) goes on the
  merge checklist.
- **Check against the chosen OpenDAL version before planning:**
  - that S3 writes accept user metadata and `stat` returns it;
  - that dropping or aborting a writer aborts the multipart upload;
  - that `copy` is a single `CopyObject` request (the 5 GiB cap);
  - which capability reports conditional "if not exists" writes.

  If user metadata isn't available, fall back to "Always ask on any change" for bucket
  targets and say so in the plan.
