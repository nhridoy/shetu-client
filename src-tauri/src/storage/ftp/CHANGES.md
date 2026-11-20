# Changes from upstream

Copied from Apache OpenDAL `opendal-service-ftp` 0.59.5 (Apache-2.0, see `LICENSE-APACHE`).
Every change Shetu made to these files is listed here.

- `opendal_core::` paths read `opendal::` (the facade re-exports the same API); the scheme
  registration function and the crate docs include were dropped.
- The FTPS TLS setup is injected (`FtpBuilder::tls`, Shetu's verifier with a pin); upstream's
  platform-certificate loading (`rustls-native-certs`, with an `expect`) is gone. `ftps://` without
  a TLS config fails to build.
- An empty root means "where the login lands" (no `CWD`); a root that can't be entered is an error
  ("<folder> doesn't exist on the server") and is never created (upstream sent `MKD`).
- Connection pools are capped at `MAX_CONNECTIONS` (4, upstream 64) and shared by `pool_key`
  across operators; `forget_pools` drops them.
- Listing and stat go through `listing.rs` (new): `MLSD` when `FEAT` advertises it (exact times),
  else `LIST -a` (dot-files), else `LIST`; `.`/`..` are skipped; MLSD's `type=OS.unix=slink:` is
  read as a link; each symlink is resolved once with `SIZE` (a size = file, otherwise folder).
- Uploads `STOR` to a hidden temp name in the target's own folder (`.<name>.shetu-<id>`, upstream
  put it in the root and used `APPE`). On publish, a server that refuses to rename onto an existing
  file has the old file moved aside first, restored if anything fails, then deleted. `abort` and
  dropping an unfinished writer let the cut transfer end and delete the temp file (upstream's
  `abort` was unsupported). An upload with no writes still creates the empty file.
- `rename` is supported (`RNFR`/`RNTO`) for files and folders (upstream: unsupported).
- A server that answers `AUTH TLS` with an error fails with `AUTH_TLS_REFUSED`; an FTPS account
  is never used as plain FTP.
- A publish cut short (pause, cancel, timeout) recovers on a fresh connection: the moved-aside old
  file goes back if the target is missing, and the backup and temp files are deleted.
- A relative root is sent to `CWD` as typed (from where the login lands), not made absolute.
- `530`/`532` (login refused) map to `PermissionDenied`, so they aren't retried as connection errors.
- Listing reads `MLSD` support from the standard `MLST` feature line too; MLSD names are taken
  whole (after the first space), so names with `;` survive. A symlink probe that loses its
  connection is an error, not a folder.
- Delete: a `550` counts as success only when the entry is really gone (`SIZE`/`NLST` check);
  otherwise it's a refusal (`PermissionDenied`).
- Downloads: when the data ends before the requested range, the final reply is read, so an
  aborted transfer (`426`) is an error; an unfinished transfer's connection is detached from the
  pool instead of returned mid-command.
- Upload clean-up runs in its own task (cancelling an abort can't drop it), bounds each wait
  (30 s), detaches connections left mid-command, and retries a cut publish's recovery with
  backoff; a failed rollback keeps its backup for that recovery.
- Presence checks (delete's 550 check, upload recovery) use the folder listing, not `SIZE`,
  which some servers lack or refuse. A clean-up that times out still deletes the temp file on
  fresh connections. An unanswered move-aside keeps the backup record for recovery. A download
  cancelled while waiting for its final reply detaches its connection.
