# FTP as a storage pane — design

Files project follow-up of the termoso gap analysis (`docs/analysis/2026-11-14-termoso-gap-analysis.md`).
It builds on S3 buckets (client #53) and WebDAV (client #54, #55), which added storage accounts,
storage panes, the transfer engine's remote side, compare, certificate trust and per-pane connect
attempts.

## Intent

Some servers people manage only offer FTP or FTPS: shared web hosting (cPanel, Plesk), NAS boxes,
embedded devices. Shetu can open SSH hosts, S3 buckets and WebDAV servers as file panes, but not
these. FTP becomes another kind of storage account, used like a bucket or WebDAV server: browse it,
move files through the transfer queue, compare it. This completes the files phase.

Shared hosting is the main audience, so FTP must behave well there: dot-files such as `.htaccess`
visible, symlinks such as cPanel's `www` usable, no stray partial files in `public_html`, and no
"too many connections" storms on hosts that allow only a few.

## Goals

- **FTP accounts** in the existing synced `storage_accounts` table, provider `ftp`. Encrypted,
  synced, shareable in team vaults. No server change.
- **The account form:** host, port (default 21), security (**FTPS** = explicit TLS, the default, or
  **FTP (unencrypted)**), username, password, starting folder (optional).
- **Sign-in:** username and password; the password is decrypted only in Rust, as for S3/WebDAV.
- **An FTP pane** does what a WebDAV pane does: list, folders, new folder, rename, delete, upload,
  download, drag and drop through the queue, and compare.
- **Certificate trust as for WebDAV:** an FTPS certificate that isn't publicly valid for the host
  shows the same dialog (host, SHA-256 fingerprint); **Trust** pins it on the account; a changed
  certificate warns with both fingerprints and never connects silently.
- **The picker** shows FTP accounts with the server icon.

## Non-goals

- Implicit FTPS (TLS from the first byte, usually port 990).
- Anonymous FTP, active mode, proxies, `SITE`/`CHMOD`, resuming uploads.
- Editing in your own app and the in-app editor (hidden for storage panes, as today).

## Anti-goals

- **No silent man-in-the-middle:** FTPS never falls back to plain FTP; a certificate that is neither
  publicly valid nor the pinned one never connects.
- **No password in the webview, logs or errors.**
- **No folders created by connecting**, ever (also not by background transfers or a later
  reconnect).
- **No partial upload left under any name** after a pause, cancel or failure, when the server lets
  us delete it.

## Decisions (from the conversation)

| Topic | Decision |
|---|---|
| Library | Our own patched copy of OpenDAL's `opendal-service-ftp` 0.59.5 (Apache-2.0) in the repo, on suppaftp with `tokio-rustls-ring`. Used through a normal OpenDAL `Operator`, so engine, panes and compare stay provider-neutral. |
| FTPS certificates | Publicly valid **or** pinned, with the WebDAV trust dialog. |
| Plain FTP | Allowed as an explicit choice, with an "unencrypted" warning. *(My call, matching WebDAV's `http://`.)* |

## Approaches considered

- **OpenDAL's FTP service as is.** Rejected after the builder check: plain `LIST` hides dot-files
  and breaks symlinks, uploads go to a temp name in the starting folder with no abort, the pool
  allows 64 connections, it can create the starting folder, and its TLS setup can't take a pin.
- **Our own FTP layer on suppaftp outside OpenDAL.** Rejected: the transfer engine, panes and compare
  all speak OpenDAL `Operator`; a parallel path would duplicate them.
- **Patched copy of OpenDAL's FTP service (chosen).** ~1,200 lines we already know work, changed
  only where listed below. Keeps the `Operator` interface.

## Design

### 1. The patched service

- Lives at `src-tauri/vendor/opendal-service-ftp/` as a path dependency, renamed (e.g.
  `shetu-opendal-ftp`), with upstream's `LICENSE` and a `CHANGES.md` listing every change below.
  It depends on the same `opendal-core` 0.59.x as `opendal`.
- **Changes from upstream:**
  1. **TLS config injected:** the builder takes a `rustls::ClientConfig` (Shetu's, with
     `PinnedVerifier` and the ring provider). No `rustls-native-certs` and no `expect` on loading
     certificates.
  2. **Listing shows everything:** `MLSD` when the server advertises it in `FEAT`; otherwise
     `LIST -a`. MLSD gives exact times and types.
  3. **Symlinks:** an entry the server reports as a link is resolved once (`SIZE` succeeds → file
     with that size; otherwise folder), so cPanel's `www` opens as a folder.
  4. **Uploads next to the target:** the temp name is `.<name>.shetu-<random>` in the **target's
     folder**; on success it is renamed over the target (deleting the target first if the server
     refuses to rename onto an existing file, only when the write is a replace); on abort, drop or
     error the temp file is deleted (best effort, with the error reported if deletion fails).
  5. **Connection cap:** at most **2** connections per account, shared by every operator built for
     that account (panes, transfers whose pane is closed, Test connection). Extra users wait for a
     free connection instead of opening more. `421` stays a temporary error (retried).
  6. **No folder creation on connect:** `CWD <root>` failing is an error, never `MKD`.
  7. **Rename capability:** `RNFR`/`RNTO`, reported as the `rename` capability, so
     `storage_rename` uses it for files and, through the same command, folders.
- Everything else (reader with `REST` resume, deleter, writer streaming) stays upstream's.

### 2. Account data (encrypted blob, `storage_accounts`)

`provider: "ftp"`. Fields in the encrypted JSON (new ones marked):

| Field | Meaning |
|---|---|
| `server` | Host name or IP, without a scheme (reused from WebDAV) |
| `port` *(new)* | Optional, default 21 |
| `ftpSecure` *(new)* | `true` = FTPS (default), `false` = plain FTP |
| `root` *(new)* | Starting folder; empty = the folder the login lands in |
| `username` | Required |
| `password` | Secret, WebDAV's patch rules |
| `trustedCertSha256` | Optional pin (reused from WebDAV) |

- Validation by provider: host required, no scheme, path or `user@`; port 1–65535; username and
  password required (an empty password patch keeps the stored one).
- The view adds `port`, `ftpSecure`, `root`; `hasSecret` reports the FTP password.
- **Starting folder:** it is the top of the pane (like WebDAV's root). Empty means "where the login
  lands": no `CWD` at all, so servers that don't jail users still open in the user's home, not `/`.

### 3. Building the operator

- `remote_for` builds the patched `Ftp` builder: host, port, secure flag, user, password, root, the
  TLS config from `tls::client_config(pin)` (factored out of `client_for`), and the per-account
  connection pool.
- The retry and timeout layers as for S3/WebDAV; no HTTP transport.
- `Remote.dav` stays `None`; FTP needs no side channel (rename is in the service).

### 4. Certificates and errors

- **Detecting:** a certificate failure surfaces from the service as an error whose source chain has
  `rustls::Error::InvalidCertificate`, so the existing `is_cert_error` applies.
- **Probe:** FTP needs its own probe: connect, read the greeting, `AUTH TLS`, then the TLS handshake
  with the recording verifier. `cert_error` picks it by provider; the payload, dialog and pin flow
  are WebDAV's unchanged.
- A server that refuses `AUTH TLS`: "This server doesn't support FTPS; choose FTP (unencrypted) if
  you trust the network."
- Background transfers never prompt (as for WebDAV).

### 5. Transfers and compare

- Unchanged engine paths. `mtime` metadata isn't written; times come from `MLSD` (exact) or `LIST`.
- `if_not_exists` isn't supported by FTP; the existing free-name/expected-version checks before
  writing apply.

### 6. UI

- The provider list gains **FTP / FTPS**. Fields as in Goals; a one-line warning under "FTP
  (unencrypted)". The trusted-certificate row with **Forget** shows for FTP as for WebDAV.
- Test connection, the trust dialog from connect and Test, the picker icon: as WebDAV.

## Left to the builder

- Crate naming and layout; how the per-account pool is keyed and shared (and dropped when an
  account is deleted or the user signs out).
- `cargo tree -i aws-lc-rs` must stay empty; one rustls provider (ring).
- **TLS session reuse on the data connection** (vsftpd's `require_ssl_reuse`): rustls resumption
  should cover it when the control and data connections share one `ClientConfig`; confirm against
  a real vsftpd/pure-ftpd over FTPS early, and record the result.
- Error text; timeouts for the probe and `SIZE` lookups.
- **Tests:** account validation and view; endpoint/config building; the patched service against an
  in-test scripted FTP responder (greeting, `USER/PASS`, `FEAT`, `MLSD` vs `LIST -a`, symlink
  resolution, `STOR` to the temp name + `RNTO`, temp deletion on abort, `CWD` failure without
  `MKD`, the connection cap); the FTP probe against a scripted `AUTH TLS` + rcgen self-signed
  handshake; FTP errors produce the `cert:` payload only for certificate failures.
- **Manual merge checklist:** a cPanel shared host over FTPS (dot-files, `www` symlink, uploads in
  `public_html`, cancel mid-upload), local `vsftpd` over plain FTP and over FTPS with a self-signed
  certificate (trust, then a changed certificate), upload/download/rename/compare.
