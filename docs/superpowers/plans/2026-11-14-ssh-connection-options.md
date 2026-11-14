# SSH Connection Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Global keepalive / connect timeout / terminal type in Settings → SSH, plus per-host keepalive override, env vars and startup snippet/command, applied on every SSH path.

**Architecture:** Global defaults live in one Rust module (`ssh_options.rs`), pushed from the settings store like `trustNewHosts`. Every russh client config is built by one helper in that module. Per-host options are read from the encrypted host payload in `ssh::load_host_config`. The interactive shell sends env requests, uses the configured TERM, and writes the startup text through the normal input channel.

**Tech Stack:** Rust (Tauri v2, russh 0.62.6), React 19 + TS, zustand, react-hook-form + zod, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-14-ssh-connection-options-design.md`

**Repo / branch:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/ssh-connection-options` (from `origin/main` ed812bc).

## Global Constraints

- **Defaults:** keepalive **30 s**; drop the connection after **3** unanswered keepalives (`keepalive_max = 3`); connect timeout **10 s**; terminal type **`xterm-256color`**.
- **Ranges:** keepalive is `0` (off) or **5–600** s, both global and per host. The connect timeout is **5–60** s. The form rejects out-of-range values. Rust clamps them (0 stays 0; 1–4 → 5; >600 → 600; timeout <5 → 5, >60 → 60).
- **Terminal type:** one of `xterm-256color`, `xterm` or `vt100`. Any other value → `xterm-256color`.
- **Env var names** must match `^[A-Za-z_][A-Za-z0-9_]*$`. Rust skips invalid names. Empty rows are dropped on save.
- **Host payload fields** (encrypted JSON): `keepaliveSecs: number | null` (null/missing = use default, 0 = off), `env: {name, value}[]`, `startup: null | {snippetId} | {command}`.
- **Startup snippet** must be in the **same vault** as the host and not deleted. Otherwise the terminal prints `Startup snippet not found` and nothing runs.
- **Env help text (exact):** "Servers ignore variables they don't allow (`AcceptEnv` in sshd_config); most allow only LANG and LC_*."
- **Env vars and startup** apply only to interactive terminal sessions on the target host. They do not apply to SFTP, forwards, the jump host or probes.
- **Ping/probe timeouts stay** as they are: `ping_host_saved` 20 s route wrapper and 2 s TCP; OS probe 5 s / 12 s.
- **No secrets in logs:** env values and startup text are never logged.
- **No AI attribution** in commits or anywhere else. Never run `biome check --write` on folders; pass only the changed files.
- **Checks:** `cd src-tauri && cargo test` (needs an empty `dist/` at the repo root: `mkdir -p dist`), `bun run test`, `bunx tsc --noEmit`, `bunx biome check <changed files>`.

## Review Focus

1. **A connection path that still uses `russh::client::Config::default()` or a hard-coded 10 s connect timeout.** Expect: none outside `#[cfg(test)]` code. Pinned by Task 1 Step 6 (grep check).
2. **A synced payload from another client version with junk values** (`keepaliveSecs: "abc"`, `-5`, `99999`, `env: "x"`, `startup: {}`). Expect: the connection still works, junk is ignored or clamped, no panic. Pinned by Task 2 tests `host_options_tolerate_junk_payload` and `clamps_out_of_range_keepalive`.
3. **A team host whose startup snippet is in the editor's personal vault.** Expect: the notice, nothing runs, no decrypt error. Pinned by Task 2 test `startup_snippet_in_other_vault_is_missing`.
4. **Editing a host in the form wipes options set elsewhere,** or an older client's edit wipes them. Expect: preserved. Pinned by Task 5 test `updateHost keeps connection options it did not patch`.
5. **A startup command typed before the shell is ready is lost or interleaved.** Expect: it is written once, after the writer task starts. Covered by the Task 3 design (sent through `SessionCmd::Input` after the slot is inserted) and checked by the final manual run.

---

### Task 1: Global SSH defaults in Rust + one config helper on every path

**Files:**
- Create: `src-tauri/src/ssh_options.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod ssh_options;`, register `ssh_options::set_ssh_defaults` next to `ssh::set_trust_new_hosts` ~line 1745)
- Modify: `src-tauri/src/ssh.rs` (`SshConfig` gains `keepalive_secs`; `connect_authenticated` TCP timeout ~694; `authenticate_over_stream` config ~712)
- Modify: `src-tauri/src/sftp.rs` (~129–137: build config via helper, wrap the TCP connect in the connect timeout)
- Modify: `src-tauri/src/ssh_route.rs` (~67 channel-open timeout, ~91 handshake-through-bastion timeout → connect timeout)

**Interfaces:**
- Produces:
  - `#[derive(Clone, Debug, PartialEq)] pub struct SshDefaults { pub keepalive_secs: u32, pub connect_timeout_secs: u32, pub term: String }`, where `Default` is `(30, 10, "xterm-256color")`.
  - `pub fn clamp_keepalive(secs: i64) -> u32`, `pub fn clamp_connect_timeout(secs: i64) -> u32`, `pub fn normalize_term(term: &str) -> String`.
  - `pub fn defaults() -> SshDefaults`, which reads a process-wide `static DEFAULTS: RwLock<SshDefaults>`. Every path reads this one value.
  - `pub fn client_config(defaults: &SshDefaults, host_keepalive: Option<u32>) -> russh::client::Config`: the effective keepalive is `host_keepalive.unwrap_or(defaults.keepalive_secs)`. 0 → `keepalive_interval = None`; otherwise `Some(secs)` and `keepalive_max = 3`. All other fields are the `Default` values.
  - `pub fn connect_timeout(defaults: &SshDefaults) -> std::time::Duration`.
  - `#[tauri::command] pub fn set_ssh_defaults(keepalive_secs: i64, connect_timeout_secs: i64, term: String) -> Result<(), String>`, which clamps and normalizes before storing.
  - `SshConfig.keepalive_secs: Option<u32>` (the struct already has `#[serde(default)]`).

- [ ] **Step 1: Write failing tests** in `ssh_options.rs` `#[cfg(test)] mod tests`:

```rust
#[test] fn defaults_match_spec() {
    let d = SshDefaults::default();
    assert_eq!((d.keepalive_secs, d.connect_timeout_secs, d.term.as_str()), (30, 10, "xterm-256color"));
}
#[test] fn clamps_out_of_range_keepalive() {
    assert_eq!([clamp_keepalive(0), clamp_keepalive(-5), clamp_keepalive(3), clamp_keepalive(45), clamp_keepalive(99_999)], [0, 0, 5, 45, 600]);
}
#[test] fn clamps_connect_timeout() {
    assert_eq!([clamp_connect_timeout(1), clamp_connect_timeout(20), clamp_connect_timeout(600)], [5, 20, 60]);
}
#[test] fn unknown_term_falls_back() {
    assert_eq!(normalize_term("vt100"), "vt100");
    assert_eq!(normalize_term("evil\nterm"), "xterm-256color");
}
#[test] fn client_config_uses_host_override_then_default() {
    let d = SshDefaults::default();
    let c = client_config(&d, None);
    assert_eq!((c.keepalive_interval, c.keepalive_max), (Some(Duration::from_secs(30)), 3));
    assert_eq!(client_config(&d, Some(0)).keepalive_interval, None);
    assert_eq!(client_config(&d, Some(120)).keepalive_interval, Some(Duration::from_secs(120)));
    let off = SshDefaults { keepalive_secs: 0, ..d };
    assert_eq!(client_config(&off, None).keepalive_interval, None);
}
```

- [ ] **Step 2: Run** `mkdir -p dist && cd src-tauri && cargo test ssh_options` — Expected: compile FAIL (module/functions missing).
- [ ] **Step 3: Implement** `ssh_options.rs` per Interfaces. Register the module and the command in `lib.rs`.
- [ ] **Step 4: Run** `cargo test ssh_options` — Expected: 5 passed.
- [ ] **Step 5: Wire every path:**
  - In `authenticate_over_stream`, use `Arc::new(ssh_options::client_config(&ssh_options::defaults(), config.keepalive_secs))`.
  - In `connect_authenticated`, replace `from_secs(10)` with `ssh_options::connect_timeout(&defaults())`.
  - In `sftp_connect`, build the config with the same helper and wrap its `TcpStream::connect` in `tokio::time::timeout(connect_timeout(..))`, with the error `connection timeout to {host}:{port}`.
  - In `ssh_route.rs`, replace the two 10 s values at ~67 and ~91 with the connect timeout.
  - Leave `ping_host_saved` (~1200, ~1206), the probes (~783, ~825) and `forwarding/runtime.rs:320`, the local destination connect, unchanged.
- [ ] **Step 6: Check** `grep -n "client::Config::default()\|from_secs(10)" src-tauri/src -r` — Expected: hits only inside `#[cfg(test)]` modules and `forwarding/runtime.rs:321`.
- [ ] **Step 7: Run** `cargo test` — Expected: all pass.
- [ ] **Step 8: Commit** `feat(ssh): global keepalive and connect timeout on every connection`

### Task 2: Per-host options from the encrypted payload

**Files:**
- Modify: `src-tauri/src/ssh.rs` (`SshConfig` gains `env`, `startup`; `load_host_config` ~1246 fills them)
- Test: `src-tauri/src/ssh_route.rs` `mod tests` (reuse `fixture()`; add a `host_with(db, crypto, id, vault, payload: serde_json::Value)` helper and a `snippet(db, crypto, id, vault, command, deleted: bool)` helper that inserts an encrypted `{"command": …}` row into `snippets` with AAD `"snippets"`)

**Interfaces:**
- Consumes: `ssh_options::clamp_keepalive` (Task 1).
- Produces:
  - `#[derive(Clone, Debug, PartialEq, Deserialize)] pub enum StartupAction { Command(String), MissingSnippet }`.
  - `SshConfig.env: Vec<(String, String)>` and `SshConfig.startup: Option<StartupAction>`, both serde-default. Quick connect leaves them empty or `None`.
  - `load_host_config` sets:
    - `keepalive_secs`: from a numeric `keepaliveSecs` through `clamp_keepalive`. Null, missing or a non-number → `None`.
    - `env`: entries whose `name` is valid per Global Constraints and whose `value` is a string.
    - `startup`: `{command: non-empty string}` → `Command`; `{snippetId}` → the decrypted snippet `command` if the row exists, is not deleted and has `vault_id == host row vault_id`, else `MissingSnippet`. Anything else → `None`.
  - The bastion config gets the same parse, but Task 3 only uses env/startup of the target.

- [ ] **Step 1: Write failing tests:**
  - `host_options_parse_keepalive_env_and_command`: payload `{keepaliveSecs: 120, env: [{name:"LANG",value:"C.UTF-8"},{name:"1BAD",value:"x"},{name:"OK_2",value:"y"}], startup:{command:"tmux a"}}`. Asserts `keepalive_secs == Some(120)`, `env == [("LANG","C.UTF-8"),("OK_2","y")]` and `startup == Some(Command("tmux a"))`.
  - `startup_snippet_resolves_in_same_vault`: snippet `s1` in the host's vault with command `"htop"` → `Some(Command("htop"))`.
  - `startup_snippet_in_other_vault_is_missing`: `s2` is in another vault → `Some(MissingSnippet)`.
  - `deleted_or_absent_snippet_is_missing`: `s3` has `deleted_at` set; `"nope"` is not in the db. Both → `Some(MissingSnippet)`.
  - `host_options_tolerate_junk_payload`: `{keepaliveSecs:"abc", env:"x", startup:{}}` → `keepalive_secs None`, env empty, `startup None`, and `resolve_saved_route` is `Ok`.
  - `legacy_payload_has_no_options`: the existing `host()` helper payload → `None` / empty / `None`.
- [ ] **Step 2: Run** `cargo test ssh_route` — Expected: compile FAIL (fields/enum missing).
- [ ] **Step 3: Implement** the fields, the enum and the parsing in `load_host_config`. Snippet lookup: `db::get_sync_row(db, Table::Snippets, id)`, then `team_keys::decrypt_row_secret(db, &session, &row.data, "snippets", &row.vault_id)`. Any lookup or decrypt error → `MissingSnippet`; never fail the connect.
- [ ] **Step 4: Run** `cargo test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(ssh): read per-host keepalive, env vars and startup from host data`

### Task 3: Interactive shell — env, TERM, startup, lost-connection notice

**Files:**
- Modify: `src-tauri/src/ssh.rs` (`run_connect_session` ~970–1090; add pure helpers + tests in the existing `mod tests`)

**Interfaces:**
- Consumes: `SshConfig.env`, `SshConfig.startup` (Task 2); `ssh_options::defaults().term` (Task 1).
- Produces:
  - `pub(crate) fn startup_bytes(command: &str) -> Vec<u8>`: the command as-is, plus `"\n"` only if it doesn't already end with `\n`.
  - `const STARTUP_MISSING_NOTICE: &str = "\r\n[Startup snippet not found]\r\n";`
  - `const CONNECTION_LOST: &str = "Connection lost (no response from server)";`

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn startup_bytes_adds_one_newline() {
    assert_eq!(startup_bytes("tmux a"), b"tmux a\n");
    assert_eq!(startup_bytes("a\nb\n"), b"a\nb\n");
}
```

- [ ] **Step 2: Run** `cargo test startup_bytes` — Expected: compile FAIL.
- [ ] **Step 3: Implement** in `run_connect_session`. Use the target's `config`; never the bastion's.
  1. After `channel_open_session`, call `channel.set_env(false, name, value)` for each `config.env` entry and ignore errors.
  2. Call `request_pty(true, &ssh_options::defaults().term, cols, rows, 0, 0, &[])`.
  3. After the `SessionSlot` is inserted, if `startup == Some(Command(c))`, send `SessionCmd::Input(startup_bytes(&c))` on the slot's `cmd_tx`. If `Some(MissingSnippet)`, `emit(.., "output", STARTUP_MISSING_NOTICE)`.
  4. In the read loop, track whether it ended via `Eof`/`Close` or `close_rx`. If `read_half.wait()` returned `None` without either, `emit(.., "error", CONNECTION_LOST)` before `"disconnected"`.
- [ ] **Step 4: Run** `cargo test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(ssh): send env vars, terminal type and startup command on connect`

### Task 4: Settings → SSH fields pushed to Rust

**Files:**
- Modify: `src/stores/settings/settingsStore.ts`, `src/stores/settings/settingsStore.test.ts`
- Modify: `src/types/settings/types.ts` (`SshTabProps`), `src/components/settings/tabs/SshTab.tsx`, `src/components/settings/tabs/SshTab.test.tsx`, `src/components/settings/modal/SettingsPanel.tsx` (~176 pass the new props)

**Interfaces:**
- Consumes: the Rust command `set_ssh_defaults { keepaliveSecs, connectTimeoutSecs, term }` (Task 1; Tauri camelCases args).
- Produces:
  - `AppSettings` gains `sshKeepaliveSecs: number` (30), `sshConnectTimeoutSecs: number` (10) and `sshTerminalType: "xterm-256color" | "xterm" | "vt100"` ("xterm-256color").
  - `parseValue` treats the two numbers like `fontSize`.
  - `pushSshDefaults(s: AppSettings)` invokes `set_ssh_defaults` (best-effort `.catch(() => {})`). It runs on `initSettings` and in `updateSetting` whenever the key is one of the three.
  - `SshTabProps` gains `sshKeepaliveSecs`, `sshConnectTimeoutSecs`, `sshTerminalType` and `onSshSettingChange(key, value)`.

- [ ] **Step 1: Write failing tests:**
  - settingsStore: `initSettings pushes SSH defaults` expects `invoke` called with `("set_ssh_defaults", { keepaliveSecs: 30, connectTimeoutSecs: 10, term: "xterm-256color" })`. `updateSetting sshKeepaliveSecs pushes the new value` expects `keepaliveSecs: 60`.
  - SshTab:
    - It renders inputs labelled "Keepalive interval (seconds)", "Connect timeout (seconds)" and "Terminal type".
    - Typing `3` into keepalive shows "Use 0 (off) or 5–600 seconds" and does **not** call `onSshSettingChange`.
    - Typing `0` calls it with `("sshKeepaliveSecs", 0)`.
    - The old sentence "configured per-host in the host settings" is gone.
- [ ] **Step 2: Run** `bun run test src/stores/settings src/components/settings/tabs/SshTab.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Help text under the section heading: "Applies to every SSH connection on this device. Hosts can override keepalive in their Advanced settings."
  - Keepalive help: "0 turns keepalive off."
  - Connect timeout validation message: "Use 5–60 seconds".
  - Commit values on blur or a valid change, following the existing Settings style.
- [ ] **Step 4: Run** the same tests plus `bunx tsc --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(settings): keepalive, connect timeout and terminal type in SSH settings`

### Task 5: Host form "Advanced" section + payload fields

**Files:**
- Modify: `src/stores/hosts/hostStore.ts` (`Host`, `HostPayload`, `createHost` plaintext ~249, `updateHost` sensitive ~297, `decryptHostRow` ~117), `src/stores/hosts/hostStore.test.ts`
- Modify: `src/lib/schema/hosts/hostFormSchema.ts`; Create: `src/lib/schema/hosts/hostFormSchema.test.ts`
- Modify: `src/components/hosts/forms/HostForm.tsx` (`HostData`, defaults, submit, new section), `src/pages/HostsPage.tsx` (~78 pass the new fields from `editingHost`)

**Interfaces:**
- Consumes: the payload shape from Global Constraints (Task 2 reads it).
- Produces:
  - `Host`, `HostData` and `HostPayload` gain `keepaliveSecs?: number | null`, `env?: { name: string; value: string }[]` and `startup?: { snippetId: string } | { command: string } | null`.
  - Form values: `keepaliveMode: "default" | "off" | "custom"`, `keepaliveSecs?: number`, `env: {name, value}[]`, `startupMode: "none" | "snippet" | "command"`, `startupSnippetId?: string`, `startupCommand?: string`.
  - Mapping on submit:
    - keepalive: default → `null`, off → `0`, custom → the number;
    - env: rows with an empty name are dropped;
    - startup: none → `null`; snippet → `{snippetId}`; command → `{command}` (trimmed and non-empty, else `null`).

- [ ] **Step 1: Write failing tests:**
  - schema:
    - `rejects custom keepalive outside 5–600` (`keepaliveMode:"custom", keepaliveSecs:3` → error on `keepaliveSecs`; `601` → error; `5` ok).
    - `rejects invalid env names` (`[{name:"1X", value:""}]` → error; `[{name:"LANG", value:"C"}]` ok; `[{name:"", value:""}]` ok, dropped later).
    - `snippet startup needs a snippet` (`startupMode:"snippet"` without an id → error).
  - hostStore:
    - `createHost stores connection options in encrypted payload`: the plaintext passed to `db_upsert` contains `keepaliveSecs: 0`, `env` and `startup: {snippetId: "s1"}`. None of them appear in row columns.
    - `updateHost keeps connection options it did not patch`: the existing payload has `env` + `startup`; patch only `name` → the plaintext still has both.
    - `getDecryptedHost returns connection options`.
- [ ] **Step 2: Run** `bun run test src/lib/schema/hosts src/stores/hosts` — Expected: FAIL.
- [ ] **Step 3: Implement** the schema fields and refinements, the store fields (`createHost` writes them; `updateHost` copies each into `sensitive` when defined in the patch; `decryptHostRow` reads them) and the form section:
  - A collapsed "Advanced" toggle below Tags/Group.
  - Keepalive select (Use default / Off / Custom) with a number input for Custom.
  - Env rows with name/value inputs, an "Add variable" button and a remove button per row, plus the exact env help text from Global Constraints.
  - Startup select (None / Snippet / Command). Snippet mode shows a select of `useSnippetStore` snippets filtered to `vaultId === currentVaultId`. Command mode shows a textarea.
  - Wire `HostsPage` to pass the three fields from `editingHost`.
- [ ] **Step 4: Run** `bun run test`, `bunx tsc --noEmit` and `bunx biome check` on the changed files — Expected: all pass.
- [ ] **Step 5: Commit** `feat(hosts): keepalive, env vars and startup action per host`

### Task 6: Final manual check

- [ ] **Step 1:** `bun run tauri dev`, then against any reachable SSH server:
  - Set a host's startup command `echo shetu-startup-ok`; connect → the line runs once.
  - Set env `LANG=C.UTF-8`; run `echo $LANG` → it shows if the server allows it.
  - Run `echo $TERM` → `xterm-256color`.
  - Set Settings → SSH keepalive to 5 and drop the network (or block the port) → after about 15–20 s the terminal shows "Connection lost (no response from server)".
- [ ] **Step 2:** Record the results in the ledger. Anything not checkable here (no server) goes in the PR body as untested.
