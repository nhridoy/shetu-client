# Import hosts from `~/.ssh/config` — design

Date: 2026-11-13 · Status: draft for approval (builder-checked)

## Intent

People switching to Shetu (it positions itself as a Termius alternative) start by
re-typing their servers. Importing the OpenSSH client config lets them get every host,
its user, port, key and jump host into Shetu in one step. Success: a user with a
typical `~/.ssh/config` clicks Import, confirms a preview, and can connect to every
imported host without editing any of them.

## Goals

- One-time import of concrete `Host` entries from the user's SSH config, including
  files pulled in by `Include`.
- Each imported host gets the settings `ssh <alias>` would use: `HostName`, `User`,
  `Port`, `IdentityFile`, `ProxyJump`, with `Host *` / pattern defaults applied.
- **Key files are imported into the vault** with their hosts (decided: option A — no
  opt-out). Passphrase-protected keys ask for their passphrase in the preview.
- Single-hop jump hosts are linked to the imported (or existing) jump host.
- A preview before anything is written, and a clear summary afterwards.

## Non-goals

- `Match` blocks, `%h`-style tokens, `ProxyCommand`, multi-hop `ProxyJump`
  (`a,b`) — the roadmap lists jump chains for later.
- `LocalForward` / `RemoteForward` / `DynamicForward` → port forwards (possible follow-up).
- Termius import, exporting to SSH config, or keeping Shetu in sync with the file.
- Choosing a different config file path (always the user's default config).

## Anti-goals

- Never read `~/.ssh` from the webview; never expose a general "read any file" command.
- Never write a host or key the user didn't see in the preview.
- No silent partial failures: anything skipped or failed is listed in the summary.

## Approaches

1. **`ssh2-config` crate in Rust, UI previews and creates** — **chosen.** Correct SSH
   semantics (first value wins, `Host *` defaults, wildcard/negated patterns, `Include`
   with globs and `~`), `get_hosts()` to list entries and `query(alias)` for the resolved
   settings. MIT, maintained (0.9.0, MSRV 1.88; toolchain is 1.98). Adds one new small
   transitive crate (`wildmatch`); its other deps are already in the lockfile; the optional
   `git2` feature stays off.
2. Hand-written Rust parser — no dependency, but likely to get precedence, patterns and
   `Include` subtly wrong. Rejected after review.
3. Parse in TypeScript — would require letting the webview read `~/.ssh`, where private
   keys live. Rejected.

## Design

### Rust (`src-tauri`)

New module `ssh_config_import.rs` with two commands.

**Pre-pass (before the crate parses):** read the main config, inline every `Include`
ourselves (paths relative to `~/.ssh`, `~` expanded, glob patterns resolved, depth-limited,
missing files skipped), and **drop `Match` blocks** (from a `Match` line up to the next
`Host`/`Match` line). The crate is then given this single sanitized text. Reason:
`ssh2-config` 0.9.0 doesn't know `Match` and applies the lines under it to the previous
`Host` block, which would silently change other hosts. The preview reports how many
`Match` blocks were ignored and from which files.

- `ssh_config_preview() -> Vec<SshConfigHost>`: parse the default config with
  `ssh2-config` (`ParseRule::ALLOW_UNKNOWN_FIELDS`). For each `Host` block, take each
  pattern that is a concrete alias (no `*`, `?`, `!`) and `query(alias)` it. Return, per
  alias: `alias`, `hostname` (falls back to the alias), `user` (optional), `port`
  (default 22), `proxy_jump` (raw string, optional), and `identity_file` — the **first**
  `IdentityFile` that exists on disk — or, **when the host has no `IdentityFile` at all, the
first existing OpenSSH default key** (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_ecdsa_sk`,
`id_ed25519_sk`, `id_rsa`, `id_dsa`, in that order), as `ssh` itself would try (decided:
option A) — with its expanded path and a `status`:
  `ready` (readable, unencrypted; include `fingerprint` + `key_type` from the existing
  `inspect_private_key` logic), `encrypted` (needs a passphrase), `missing`, or
  `unreadable`. For `encrypted` keys, the fingerprint comes from the `.pub` file next to
  the key when present (used to spot keys already in the vault). Private key contents are
  **not** returned here. A missing config file
  returns an empty list, not an error.
- `ssh_config_read_key(path) -> String`: returns the key file's contents **only if**
  `path` is one of the key paths a fresh `ssh_config_preview` would return (configured
  `IdentityFile`s plus the default key it fell back to); otherwise an error. This keeps the command from becoming a general file reader.

Both commands are unit-tested against fixture configs in a temp "home" (the crate's
home directory is configurable): defaults from `Host *`, patterns skipped, `Include`
followed (including globs), `Match` blocks dropped and counted, default-key fallback,
missing key reported, path allow-list enforced.

### UI

- **Entry point:** an **Import** button (secondary, beside **New Host** on the Hosts
  section title) opens an "Import from SSH config" dialog.
- **Preview dialog:** one row per alias, all selected by default:

  ```
  [x] prod-eu-1   deploy@10.0.4.12:22    🔑 id_ed25519            via bastion
  [x] bastion     ec2-user@1.2.3.4:22    🔑 id_ed25519
  [x] db-01       postgres@10.0.4.30     🔑 db_key  [passphrase: ____ ]
  [ ] old-box     root@old.example.com   ⚠ key file missing — host imported without a key
  [–] telehack    already in Shetu
  ```

  - Rows whose alias matches an existing host name (case-insensitive) are shown as
    "already in Shetu" and cannot be selected.
  - `encrypted` keys show a passphrase field. Each distinct key file is asked for once.
    A wrong passphrase is reported inline when Import is pressed; a blank one imports the
    host without the key.
  - A multi-hop `ProxyJump`, one whose target isn't an imported/existing host, or one whose
    target itself has a `ProxyJump` (Shetu supports one hop; the bastion can't have its own
    jump host) shows a warning, and that host is imported without a jump host. In a chain
    A→B→C, B keeps its link to C and A is imported without one.
  - When any `Match` blocks were ignored, a notice above the list says so and names the files.
  - Footer: "Import N hosts and M keys into <vault>" + Cancel.
- **Import:** for the selected rows, in order:
  1. Keys: each distinct key file once. If a key with the same fingerprint already exists
     in the vault, reuse it. Otherwise read it via `ssh_config_read_key` and create it with
     the existing `importKey` (pre-generated `id`, name = file name, passphrase stored as
     today). Failures are collected, not thrown.
  2. Hosts: `createHost` (extended to accept a pre-generated `id` and an option to skip the
     automatic OS probe — imports must not open SSH connections; OS is detected on first
     connect; failures are read from the store's error and collected) with name = alias, address = `HostName`, user = `User` (or
     `root`, the app's current default), port, `authType = "key"` with `keyId` when a key
     was imported/reused, otherwise `"password"`. Placed in the group currently open (top
     level if none), in the current vault.
  3. Jump hosts: after all hosts exist, set `jumpHostId` for single-hop `ProxyJump` whose
     target alias maps to an imported or existing host.
- **Summary:** toast "Imported N hosts and M keys", plus a list in the dialog of anything
  skipped or failed (with the reason) before it closes.

### Data and security

- Imported keys follow the existing key path: encrypted on the device, synced (still
  encrypted) when sync is on — the same as importing a key by hand.
- `~/.ssh` is only read by the two Rust commands; the read command is restricted to the
  config's own `IdentityFile` paths.
- Nothing is written until Import is pressed.

## Left to the builder

- Exact component structure, dialog styling (reuse existing modal and form components).
- Error message wording.
- Whether preview rows show the full key path on hover.

## Calls made without asking (please check)

- Only concrete aliases are imported; pattern blocks only supply defaults.
- Duplicates are detected by host name, because addresses stay encrypted in list state.
- First existing `IdentityFile` only (SSH tries several; Shetu stores one key per host).
- `Match` blocks are dropped in a Rust pre-pass that also inlines `Include` files.
- Jump chains: the bastion keeps its own link; the host behind it is imported without one.
- Import never opens SSH connections (OS probe skipped).
- Encrypted keys are de-duplicated via their `.pub` file when present.
- Missing `User` falls back to `root`, matching how the app creates hosts today.
- Imported hosts go into the currently open group; no new group or tag is created.
