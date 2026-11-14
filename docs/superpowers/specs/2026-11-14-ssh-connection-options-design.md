# SSH connection options — design

Phase "SSH essentials", sub-project A of three (A: connection options → B: auth → C: credential
reuse). Source: `docs/analysis/2026-11-14-termoso-gap-analysis.md` §3.A.

## Intent

Users coming from Termius/Termoso expect sessions that survive idle time, per-host environment
variables and a command that runs on login. Shetu has none of these. The Settings → SSH tab even
says "SSH client options are configured per-host in the host settings", but the host form has no
such options. Success: idle sessions behind NAT stay up, and a host can set env vars and a startup
snippet/command that run on every terminal connect.

## Goals

**Global, Settings → SSH (per device, stored in `settings.json`, not synced):**
- **Keepalive interval**, default **30 s** (0 = off). Drop the connection after **3** unanswered
  keepalives. Today `russh::client::Config::default()` has no keepalive.
- **Connect timeout**, default **10 s** (range 5–60). Replaces the hard-coded 10 s TCP connect
  timeouts in `ssh.rs` / `sftp.rs` / `ssh_route.rs` / `forwarding/runtime.rs`.
- **Terminal type**, default **xterm-256color**. The choices are xterm-256color, xterm and vt100.
  Today `request_pty` hard-codes `xterm`, so many apps get 8 colours.
- Replace the stale "configured per-host" sentence with accurate help text.

**Per host, in the host form under a collapsed "Advanced" section (stored in the encrypted host
payload, so it syncs):**
- **Keepalive:** "Use default" (default), "Off", or a custom number of seconds.
- **Environment variables:** name/value rows. They are sent as SSH `env` requests (`set_env`)
  before the shell starts. The help text says: "Servers ignore variables they don't allow
  (`AcceptEnv` in sshd_config); most allow only LANG and LC_*." (user's decision: env requests,
  not typed `export` lines).
- **Startup:** None (default), a snippet picked from the user's snippets, or a custom command.
  It is written to the shell, followed by a newline, right after the shell opens. It runs on every
  terminal connect and reconnect.

**Where the settings apply:**
- Global options apply to **every** SSH connection: terminal, SFTP, port forwards, jump-host hops,
  ping/OS probe. Ping and OS probe keep their own short timeouts.
- Per-host keepalive applies to that host's connection. On a routed connection, each hop uses its
  own host's setting.
- Env vars and startup apply only to interactive terminal sessions on the target host. They do not
  apply to SFTP, forwards or the jump host.
- Quick connect (`connect`, no saved host) uses the global options only.

## Non-goals

- Inheriting these options through groups (sub-project C).
- Agent forwarding, keyboard-interactive, `.ppk` (sub-project B).
- Sending env vars as typed `export` commands; X11; per-host terminal type; charset options.
- Syncing global settings across devices (a later "settings sync" item).

## Anti-goals

- A setting that some connection path silently ignores (for example, port forwards without
  keepalive).
- Secrets leaking: env values and startup commands stay inside the encrypted host payload and are
  never logged.
- Breaking older clients' data: older versions that edit a host must not erase the new fields.
  `updateHost` already merges the existing decrypted payload (`{ ...existing, ...sensitive }`), so
  this holds. Keep it that way.

## Constraints

- Tauri v2 + React 19 + zustand client. russh 0.62.6 already provides `Config.keepalive_interval`
  and `keepalive_max`, `Channel::set_env`, and `request_pty(term, …)`.
- Saved hosts are resolved entirely in Rust: `ssh::load_host_config` decrypts the host row and key
  row, and `ssh_route` calls it for the target and bastion. The SFTP and forwarding saved paths go
  through the same function.
- Global settings follow the existing `trustNewHosts` pattern: a settings-store key that is pushed
  to Rust on load and on change (`settingsStore.ts` → `invoke("set_…")`) and held in Rust state
  that every connection path can reach (`SshSessions` is already passed to SFTP and forwarding).
- Tests first: cargo tests for config building, payload parsing and the env/startup sequence;
  vitest for the settings tab and the host form section.
- No AI attribution anywhere.

## Approaches considered

1. **Frontend merges everything** and passes the final options on each connect. Simple, but Rust
   paths that connect without the frontend (forward start/reconnect) would miss the globals.
2. **Globals held in Rust; per-host options read from the encrypted payload in
   `load_host_config`; Rust merges and builds every russh config through one helper.**
   **Chosen** (designer's call; the user handed over the how). It reuses the `trustNewHosts`
   pattern, no connection path can skip it, and secrets don't cross IPC.
3. **A separate Rust-side store** for per-host options. It duplicates the host payload. Rejected.

## Design

### Data

The host payload (encrypted JSON) gains these optional fields, written by the host form through
`createHost`/`updateHost`:

```json
{
  "keepaliveSecs": null | 0 | <number>,
  "env": [{ "name": "LANG", "value": "en_US.UTF-8" }],
  "startup": null | { "snippetId": "<id>" } | { "command": "<text>" }
}
```

A missing or null `keepaliveSecs` means "use default", and 0 means off. Env names must match
`[A-Za-z_][A-Za-z0-9_]*`. The form validates this, and Rust skips invalid names. Empty rows are
dropped on save.

Settings gain `sshKeepaliveSecs: 30`, `sshConnectTimeoutSecs: 10` and
`sshTerminalType: "xterm-256color"`. They are pushed to Rust as one `set_ssh_defaults` command.

### Rust

- `SshDefaults { keepalive_secs, connect_timeout_secs, term }` lives in `SshSessions`
  (shared, mutable). `set_ssh_defaults` updates it.
- `SshConfig` gains `keepalive_secs: Option<u32>`, `env: Vec<(String, String)>` and
  `startup_command: Option<String>`. `load_host_config` fills them from the payload. For
  `{snippetId}`, it decrypts the snippet row and uses its command. If the snippet is missing, the
  terminal shows a one-line notice and nothing runs.
- One helper builds the `russh::client::Config` from the defaults and the per-host override.
  Keepalive becomes `keepalive_interval` with `keepalive_max = 3`. All
  `russh::client::Config::default()` call sites use it, and all TCP connect timeouts read
  `connect_timeout_secs`.
- Interactive shell sequence (`connect`/`connect_saved`): open the channel, send each `set_env`
  (`want_reply = false`, failures ignored), call `request_pty(term, …)` and `request_shell`, then
  write `startup_command + "\n"` if one is set.
- A connection dropped by keepalive surfaces through the existing disconnect path, with a message
  such as "Connection lost (no response from server)".

### Frontend

- Settings → SSH: three fields (keepalive seconds with "0 = off", connect timeout, terminal type
  select) next to the existing "Trust new hosts" toggle.
- Host form: a collapsed "Advanced" section with keepalive (select + number), an env rows editor
  (add/remove) and startup (None / Snippet picker / Command textarea). When editing, existing
  values are loaded from the decrypted payload.

## Calls made after the builder check (designer's calls — flagged for review)

1. **Snippet vault:** the startup picker lists only snippets in the **host's vault**. Rust looks up
   the snippet by id and requires `snippet.vault_id == host.vault_id`. Otherwise it treats the
   snippet as missing (terminal notice, nothing runs). A team host therefore never references a
   member's personal snippet.
2. **Team hosts:** a team host's env vars and startup run for every member who connects, the same
   as Termius. That is the same trust as the shared credentials and address, which any editor can
   already change. There is no extra confirmation. The form shows the startup command, so it is
   never hidden.
3. **Keepalive drop on SFTP/forwards:** these use their existing disconnect handling, with no new
   reconnect logic. Forward reconnect belongs to the "terminal productivity" phase.
4. **Timeouts:** each TCP connect and each jump-hop `direct-tcpip` channel open uses the connect
   timeout. Ping (`ping_host_saved`, including its 20 s route wrapper and 2 s TCP check) and the OS
   probe (5 s / 12 s) keep their own short timeouts, because they are background checks, not
   connections the user started.
5. **Ranges:** keepalive is 0 (off) or 5–600 s, global and per host. The connect timeout is 5–60 s.
   The form rejects values outside these ranges. Rust clamps synced values into range, because
   payloads can come from other client versions.
6. **Startup write timing:** the startup text is sent through the session's normal input path
   (`SessionCmd::Input`) once the writer task is running, so it is neither lost nor reordered.
   Multi-line snippets are sent as-is, with one trailing newline added if missing.

## Left to the builder

- Exact layout and copy within the existing Settings and HostForm style.
- How `SshDefaults` is shared (a field on `SshSessions` or a separate managed state), provided
  every path reads the same value.
- Whether `russh::client::Config.inactivity_timeout` stays `None` (recommended; keepalive does the
  job).
