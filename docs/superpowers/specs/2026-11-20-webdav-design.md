# WebDAV as a storage pane — design

Files project 4 of the termoso gap analysis (`docs/analysis/2026-11-14-termoso-gap-analysis.md`).
It builds on S3 buckets (client #53, server #12), which added storage accounts, storage panes,
the transfer engine's remote side, and compare.

## Intent

People keep files on WebDAV servers: Nextcloud, ownCloud, Synology or QNAP NAS boxes, cPanel
"Web Disk", pCloud, Koofr. Shetu can open SSH hosts and S3 buckets as file panes, but not these.
WebDAV becomes another kind of storage account. You can browse it, move files to and from it
through the transfer queue, and compare it, the same as a bucket. Home NAS boxes often use a
self-signed HTTPS certificate, so you can trust a specific server's certificate the way you
trust an SSH host key.

## Goals

- **WebDAV accounts:** saved in the existing synced `storage_accounts` table with provider
  `webdav`. Encrypted and synced, and shareable in team vaults. No server change.
- **The account form** offers two kinds:
  - **Nextcloud / ownCloud:** you enter the server and username. The URL is built as
    `https://<server>/remote.php/webdav/`.
    *(My call: the legacy path needs no internal user ID, so it also works when people log
    in with an email address. Both Nextcloud and ownCloud still serve it.)*
  - **Other WebDAV:** you enter a full URL. `http://` and `https://` are both allowed.
- **Sign-in:** username and password. The password is decrypted only in Rust and never sent back
  to the webview, the same as the S3 secret.
- **A WebDAV pane** does everything a bucket pane does: list, folders, new folder, rename,
  delete, upload, download, drag and drop through the queue, and compare.
- **Rename** uses the server's own move (WebDAV MOVE), which is instant for files and whole
  folders. The S3-only parts (the 5 GiB copy limit and the folder-count prompt) don't apply.
- **Trusting a certificate:**
  1. Connecting or testing a server whose certificate isn't trusted shows the server and the
     certificate's SHA-256 fingerprint.
  2. **Trust** saves the fingerprint with the account, encrypted and synced, then retries.
  3. From then on, a connection succeeds if the certificate is publicly valid **or** exactly
     matches the saved fingerprint.
  4. A different certificate later shows a "certificate changed" warning with both
     fingerprints, and never connects silently.
- **The pane button** "Connect Bucket" becomes **"Connect Storage"**. The picker shows each
  account with an icon for its kind (bucket or server).

## Non-goals

- FTP. It comes next, as a small follow-up.
- Bearer-token sign-in.
- Editing in your own app, the in-app editor, upload resume, and Nextcloud-specific features
  (shares, trash, versions).
- Trusting a whole CA, or a global "ignore certificate errors" switch.
- Client certificates (mutual TLS).

## Anti-goals

- **No silent man-in-the-middle:** a certificate that is neither publicly valid nor the
  pinned one never connects.
- **No password in the webview, logs or errors.**
- **WebDAV-only code in the transfer engine stays minimal.** WebDAV is an OpenDAL `Operator`
  like S3 for everything except the upload body, which is a streaming PUT (section 2a).

## Decisions (from the conversation)

| Topic | Decision |
|---|---|
| Scope | WebDAV now; FTP as a follow-up. |
| Sign-in | Username and password. |
| Form | A Nextcloud / ownCloud preset plus Other WebDAV (full URL). |
| Self-signed HTTPS | Trust the server's certificate (fingerprint pinned per account). |
| Large uploads | Shetu sends WebDAV uploads itself as one streaming PUT, in constant memory and at any size. OpenDAL's WebDAV writer buffers the whole file and accepts only one write, so the engine's 8 MiB parts would fail. |

## Approaches considered

- **WebDAV as another provider in the existing storage system.** Chosen. Accounts, panes,
  transfers and compare are already provider-neutral, because they go through OpenDAL
  `Operator`s. A separate table or pane type would duplicate them.
- **How a self-signed certificate is trusted:**
  - **Pinning the fingerprint per account, trust on first use.** Chosen. It works like SSH host
    keys.
  - **A global "ignore certificate errors" switch.** Rejected. It would accept anyone posing as
    the server.
  - **Importing the server's certificate file.** Rejected. It is more friction for the same
    protection.

## Design

### 1. Account data (encrypted blob, `storage_accounts`)

`provider: "webdav"`. Fields in the encrypted JSON:

| Field | Meaning |
|---|---|
| `webdavKind` | `"nextcloud"` or `"other"` |
| `server` | Nextcloud only: a host (and optional port or path prefix), without a scheme |
| `url` | Other only: a full `http(s)://…` URL |
| `username` | Required |
| `password` | Secret: patch rules like `secretAccessKey`; only Rust reads it |
| `trustedCertSha256` | Optional: the pinned fingerprint, as lowercase hex |

- S3 fields stay as they are for S3 providers. Validation depends on the provider; the bucket
  is required only for S3.
- The view the form receives adds `webdavKind`, `server`, `url`, `username` and
  `trustedCertSha256`, plus `hasSecret`. It never includes the password.
- Saving with an empty password keeps the stored one.

### 2. Building the operator

- **Endpoint:**
  - Nextcloud: `https://{server}/remote.php/webdav/`.
  - Other: the URL as given.
  - The OpenDAL WebDAV builder gets `endpoint` (scheme and authority) and `root` (the path
    part), plus `username` and `password`.
- **Certificates:** with `trustedCertSha256` set, the operator gets its own HTTP transport
  (`Operator::with_context(OperationContext::new().with_http_transport(..))`, wrapping a
  reqwest client). The client's rustls verifier:
  1. accepts a certificate chain that verifies against the normal roots for the host name;
  2. otherwise, accepts the leaf certificate only if its SHA-256 equals `trustedCertSha256`;
  3. otherwise, refuses.

  Accounts without a pin use the default transport, unchanged.
- **The same layers as S3:** retry, plus the timeouts that are long enough for large transfers.
- **The `mtime` user metadata is never written for WebDAV.** OpenDAL would send it as a
  PROPPATCH after the PUT, and on servers that refuse PROPPATCH (cPanel, some NAS boxes) the
  file lands but the job fails, and a retry adds a `(copy)`. Times come from section 2a
  instead. *(My call.)*
- **Rename** (`storage_rename`) uses `op.rename` when the operator reports the `rename`
  capability (WebDAV), for files and folders alike. The S3 copy-then-delete path stays for
  operators without it. The existing "refuse an existing name" check runs first for both.

### 2a. Streaming upload (WebDAV only)

- **How it works:** for a WebDAV destination, the transfer engine's remote writer doesn't use
  OpenDAL's writer. It sends one HTTP `PUT {endpoint}{root}{key}`:
  - the body streams from the source in chunks, so memory stays constant at any size;
  - Basic auth uses the account's username and password;
  - the HTTP client is the same one OpenDAL uses for that account, including the
    trusted-certificate verifier from section 2.
- **Headers:** `X-OC-Mtime: <source mtime, seconds>`. Nextcloud and ownCloud set the file's
  modified time from it. Other servers ignore it, so their file times are the upload time.
  Compare already matches buckets and servers by size and stats changed files for the
  newer-file check, so this only means more "newer" prompts on servers that ignore it.
- **The response:** `201`, `204` or `200` counts as done. Anything else becomes a `JobError`
  using the same rules as OpenDAL errors:
  - `401` and `403` are operation errors;
  - `404` or `409` means the parent folder is missing (an operation error);
  - `412` means `DEST_CHANGED`;
  - `5xx` and network errors are connection errors.
- **What stays the same:** the free name, the expected-version check and `if_not_exists`
  (`If-None-Match: *`) are applied as for S3, and downloads still go through OpenDAL with
  ranges, so they resume.
- **Cancel and pause** drop the request. Most servers (Nextcloud included) write to a temporary
  file and discard an incomplete PUT. Some may keep a partial file, which the next attempt
  replaces. *(Known limit.)*
- **Where it lives:** a small `storage::webdav` module (PUT and error mapping), reached from
  `io::open_part` when the destination is a WebDAV account. The remote `Side` carries enough
  to know that: either the account kind, or a `RemoteWriter` variant built by the session.

### 3. Finding and trusting a certificate

- **Detecting it:** when `storage_connect` or `storage_test` fails because the certificate isn't
  trusted, Rust probes the server once. It makes a TLS connection to the host and port, records
  the presented leaf certificate, and returns a structured error to the web side:
  `{ kind: "untrusted-cert" | "cert-changed", host, sha256, previous? }`.
- **The dialog** (built like the SSH host-key dialog) shows:
  - the server and the SHA-256 fingerprint;
  - for a changed certificate, the old and new fingerprints and a warning.
- **The choices:**
  - **Trust from a pane's connect** (a saved account): saves `trustedCertSha256` through
    `storage_account_save`, then retries the connect.
  - **Trust from the form's Test connection:** puts the fingerprint into the form's patch and
    retries the test with it. It is saved only when the user presses Save. *(My call: an
    unsaved account is never created by Trust.)*
  - **Cancel:** does nothing.
- **Team vaults:** any member who can edit the account can pin or re-pin its certificate.
  Changing the URL or password already needs the same right, so a pin adds no new power.
  *(My call.)*
- **Background transfers** never prompt. An untrusted certificate fails the job with a plain
  message ("The server's certificate isn't trusted — open the account to review it").

### 4. UI

- **The Storage tab form:**
  - The provider list gains **WebDAV**. Choosing it shows a kind toggle
    (Nextcloud / ownCloud, or Other).
  - Fields: server or URL, username, and password ("Saved" when stored). For Nextcloud, the
    URL that will be used is shown read-only.
  - Test connection works as before. The lifecycle-rule note shows only for S3 providers.
  - When a certificate is pinned, it is shown with **Forget** (which clears it).
- **Panes:**
  - The empty-pane button reads **Connect Storage**.
  - The picker shows a cloud icon for S3 accounts and a server icon for WebDAV accounts.
  - The certificate dialog can open from a pane's connect as well as from the form.
- **Compare and transfers:** unchanged. A WebDAV pane is a `"storage"` side, matched by size,
  and its saved times are read for the newer-file check.

## Left to the builder

- **Which reqwest 0.13 and rustls APIs** build the per-account client: a preconfigured rustls
  config with a custom `ServerCertVerifier` that delegates to the standard webpki verifier
  first. It must use the ring provider the app already uses (no aws-lc). Add direct
  dependencies only where OpenDAL's re-exports aren't enough.
- **How the probe gets the leaf certificate:** for example, `tokio-rustls` with a recording
  verifier. Note that `http://` endpoints never need it.
- **The exact error shape** and how the web side tells a certificate error from other errors.
- **Tests:**
  - the verifier against a generated self-signed certificate (`rcgen`, dev-only), covering
    pinned-match, pinned-mismatch and no pin;
  - URL building for Nextcloud and Other;
  - the patch rules for `password`;
  - rename using `op.rename` (the in-memory or filesystem backend reports `rename`).
- **On the manual merge checklist:** a real Nextcloud, plus a NAS or `rclone serve webdav` with
  a self-signed certificate.
