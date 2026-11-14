# Host key check on first contact + Rust tests in CI — short design

From the Termoso gap analysis (docs/analysis/2026-11-14-termoso-gap-analysis.md), P0.

## Problem
- A first-seen SSH host key is trusted silently (src-tauri/src/ssh.rs `check_server_key`,
  `HostKeyStatus::Unknown`). Only a *changed* key prompts.
- The OS-detection probe (`probe_os`, `probe_os_saved`) connects before the interactive connection
  and also trusts unknown keys silently, so it would pre-empt any prompt.
- The prompt listener (`ssh-host-key-changed`) is registered per terminal tab
  (src/lib/terminal/sessionManager.ts). An SFTP connection with no terminal open has no listener,
  so a host-key prompt there waits forever.
- Client CI (.github/workflows/ci.yml) never runs `cargo test`.

## Decisions (user-approved)
1. **Interactive connections prompt on first contact** — terminal, SFTP, and the jump host on those
   paths. Dialog: host:port, key type, SHA256 fingerprint; buttons **Trust and connect** / **Cancel**.
   Changed keys keep a red MITM warning in the same dialog component (old + new fingerprint).
2. **One app-wide listener + dialog**, mounted once (App level), replacing the per-tab listener.
   One Rust event for both cases, e.g. `ssh-host-key-prompt` with `kind: "new" | "changed"`.
   Concurrent prompts for the same host:port share one dialog (existing `pending_keys` merging).
3. **Background connections never trust a new key**: OS probe treats Unknown as reject (no OS icon
   on the very first connect; detected next time). Port forwards already require a known host.
4. **"Always trust new hosts" setting** (Settings → SSH, off by default): when on, interactive
   first-contact keys are trusted without a prompt (changed keys still prompt; background
   connections still never trust). Stored in settings.json; pushed to Rust state on start and on change.
5. Existing known_hosts entries are unaffected.
6. **CI**: add a job that installs Tauri's Linux build dependencies (as the release workflow does),
   creates an empty `dist/`, and runs `cargo test --manifest-path src-tauri/Cargo.toml`.

## Out of scope
Known-hosts sync, cert-authority keys, per-host trust settings.

## Tests (test-first)
Rust: Unknown + interactive → emits prompt kind "new" and accepts only after `accept_host_key(true)`;
Unknown + non-interactive → rejected, not saved; Unknown + trust-new-hosts on + interactive → saved
without prompt; Changed still prompts even with trust-new-hosts on. TS: the app-wide dialog shows
new/changed variants and calls accept_host_key with the choice; only one listener exists; the
setting toggles the Rust flag.
