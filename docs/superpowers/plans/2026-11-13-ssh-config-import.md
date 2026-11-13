# Import hosts from `~/.ssh/config` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Import" action on the hosts page that previews the hosts in the user's SSH config and imports them, with their key files, into the current vault.

**Architecture:** Rust reads and sanitizes the config (inline `Include`, drop `Match`), parses it with `ssh2-config`, resolves each alias's settings and key file, and exposes two Tauri commands. A pure TypeScript planner turns that preview plus the vault's existing hosts and keys into rows; an executor imports keys then hosts with pre-generated ids; a modal shows the preview and the summary.

**Tech Stack:** Rust (Tauri v2, `ssh2-config` 0.9, `glob` 0.3, russh keys), React + TypeScript, zustand stores, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-ssh-config-import-design.md`

## Global Constraints

- Dependencies: add only `ssh2-config = "0.9"` (default features; `reload-ssh-algo` stays off) and `glob = "0.3"` (already in the lockfile) to `src-tauri/Cargo.toml`.
- `~/.ssh` is read only by Rust. `ssh_config_read_key` returns contents only for a path the preview would list; any other path → `Err`.
- Nothing is written to the vault before the user presses Import. Import never opens SSH connections (no OS probe).
- Commit messages: conventional commits, **no Claude/AI attribution** of any kind.
- Rust tests need a `dist/` folder to compile: `mkdir -p dist && touch dist/.placeholder-for-cargo-test` before, remove it after.
- Default key order when a host has no `IdentityFile`: `id_ed25519`, `id_ecdsa`, `id_ecdsa_sk`, `id_ed25519_sk`, `id_rsa`, `id_dsa` (in `~/.ssh`).
- Missing `User` → `"root"`; missing `Port` → `22`; missing `HostName` → the alias.

## Review Focus

1. **No `~/.ssh/config` (or no `~/.ssh` at all)** → preview is empty and the dialog says "No hosts found in ~/.ssh/config"; not an error. Test: Task 1 `missing_config_is_empty`, Task 5 empty-state test.
2. **`Host a b` (several aliases on one line) and `Host web-*` mixed with concrete names** → each concrete alias becomes its own row, patterns never do. Test: Task 1 `lists_each_concrete_alias`.
3. **Key file that can't be read as a private key** (a `.pub` given as `IdentityFile`, an unsupported `-sk` key, junk) → status `unreadable`, the host still imports without a key. Test: Task 2 `unreadable_key_is_reported`.
4. **One key shared by many hosts** → imported once, linked to all. Test: Task 4 `same_key_file_imported_once`.
5. **Wrong passphrase** → that key fails with a message, its hosts import without a key, everything else still imports. Test: Task 4 `wrong_passphrase_does_not_abort`.

---

### Task 1: Read and parse the SSH config (Rust)

**Files:**
- Create: `src-tauri/src/ssh_config_import.rs`
- Modify: `src-tauri/Cargo.toml` (deps above), `src-tauri/src/lib.rs` (`mod ssh_config_import;`)

**Interfaces:**
- Produces (used by Task 2):
  - `pub(crate) fn sanitize_config(home: &Path) -> (String, Vec<String>)` — returns the main config with every `Include` inlined (paths relative to `<home>/.ssh`, `~` expanded, globs via `glob`, recursion depth ≤ 8, missing files skipped) and every `Match` block removed (from a `Match` line to the next `Host`/`Match` line, case-insensitive keywords, `Keyword=value` and `Keyword value` forms); the `Vec<String>` names each file that had at least one `Match` block. Missing main config → `(String::new(), vec![])`.
  - `pub(crate) struct ParsedHost { pub alias: String, pub hostname: String, pub user: Option<String>, pub port: u16, pub proxy_jump: Option<String>, pub identity_files: Vec<PathBuf> }`
  - `pub(crate) fn parse_hosts(home: &Path) -> Result<(Vec<ParsedHost>, Vec<String>), String>` — runs `sanitize_config`, parses with `SshConfig::default().home_dir(home).parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS)`, takes every `HostClause` in `get_hosts()` that is not negated and has no `*`/`?`, dedupes aliases (first wins), and fills each from `query(alias)`. `proxy_jump` is the crate's `Vec<String>` joined with `,`. Second value = the Match files from `sanitize_config`.

- [ ] **Step 1: Write failing tests** in a `#[cfg(test)] mod tests` that build a temp home (`std::env::temp_dir().join(format!("shetu-sshcfg-{}", uuid::Uuid::new_v4()))`) with `.ssh/config`:
  - `missing_config_is_empty`: no `.ssh` → `parse_hosts` = `Ok((vec![], vec![]))`.
  - `lists_each_concrete_alias`: `Host web-*\n  User www\nHost a b\n  HostName 10.0.0.1\nHost !c d` → aliases `["a","b","d"]`; `a.hostname == "10.0.0.1"`.
  - `applies_host_star_defaults`: `Host prod\n  HostName p.example.com\nHost *\n  User deploy\n  Port 2222` → `prod.user == Some("deploy")`, `prod.port == 2222`; a host with its own `User` keeps it (first value wins).
  - `follows_include_with_glob`: config `Include config.d/*`, files `.ssh/config.d/one` (`Host one`) and `.ssh/config.d/two` (`Host two`) → aliases contain `one` and `two`.
  - `drops_match_blocks`: `Host x\n  User xu\nMatch host *.corp\n  User corpuser\nHost y\n  HostName y.example.com` → `x.user == Some("xu")`, `y.user == None`, Match files == `[<path of config>]`.
  - `proxy_jump_kept_raw`: `Host z\n  ProxyJump bastion,edge` → `z.proxy_jump == Some("bastion,edge")`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --lib ssh_config_import` — Expected: FAIL to compile (module/functions missing).
- [ ] **Step 3: Implement** `sanitize_config`, `ParsedHost`, `parse_hosts` as specified; add the two dependencies and `mod ssh_config_import;`.
- [ ] **Step 4: Run** the same command — Expected: 6 passed.
- [ ] **Step 5: Commit** `feat(ssh-import): parse ~/.ssh/config with Include and Match handling`

### Task 2: Resolve key files and expose the commands (Rust)

**Files:**
- Modify: `src-tauri/src/ssh_config_import.rs`, `src-tauri/src/keys.rs` (make `metadata_for_key` `pub(crate)`), `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: `parse_hosts`, `ParsedHost` (Task 1); `keys::metadata_for_key`.
- Produces (serialized camelCase, used by Tasks 3–5):
  - `#[derive(Serialize)] pub struct SshConfigHost { alias, hostname, user: Option<String>, port: u16, proxy_jump: Option<String>, key: Option<SshConfigKey> }`
  - `#[derive(Serialize)] pub struct SshConfigKey { path: String, file_name: String, status: &'static str /* "ready" | "encrypted" | "missing" | "unreadable" */, fingerprint: Option<String>, key_type: Option<String> }`
  - `#[derive(Serialize)] pub struct SshConfigPreview { hosts: Vec<SshConfigHost>, ignored_match_files: Vec<String> }`
  - `pub(crate) fn preview(home: &Path) -> Result<SshConfigPreview, String>`
  - `pub(crate) fn read_key(home: &Path, path: &str) -> Result<String, String>`
  - Tauri commands `ssh_config_preview() -> Result<SshConfigPreview, String>` and `ssh_config_read_key(path: String) -> Result<String, String>`, both using `dirs::home_dir()`.

Key choice per host: first `identity_files` entry that exists; if `identity_files` is empty, the first existing default key (Global Constraints order); if configured files exist but none is on disk, `key = Some(status "missing", path = first configured)`; if nothing configured and no default exists, `key = None`. Status: decode with `russh::keys::decode_secret_key(content, None)` → `ready` + `metadata_for_key` fingerprint/type; `Err(russh::keys::Error::KeyIsEncrypted)` → `encrypted`, fingerprint from `<path>.pub` via `russh::keys::PublicKey::from_openssh(..).fingerprint(HashAlg::Sha256)` when that file parses; any other failure → `unreadable`.

- [ ] **Step 1: Write failing tests** (same temp-home helper; generate keys with `russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519)` and write them with `to_openssh(LineEnding::LF)`, encrypted variant via `.encrypt(&mut rng, "pw")`):
  - `configured_key_ready_with_fingerprint`: `IdentityFile ~/.ssh/work` → `status == "ready"`, `fingerprint` starts with `"SHA256:"`, `file_name == "work"`.
  - `falls_back_to_default_key`: no `IdentityFile`, `~/.ssh/id_rsa` absent, `~/.ssh/id_ed25519` present → key path ends with `id_ed25519`.
  - `encrypted_key_uses_pub_fingerprint`: encrypted key + matching `.pub` → `status == "encrypted"`, fingerprint equals the `.pub` fingerprint.
  - `missing_key_reported`: `IdentityFile ~/.ssh/gone` → `status == "missing"`.
  - `unreadable_key_is_reported`: `IdentityFile ~/.ssh/junk` containing `not a key` → `status == "unreadable"`.
  - `read_key_only_allows_listed_paths`: `read_key(home, <listed path>)` → `Ok(contents)`; `read_key(home, "<home>/.ssh/config")` → `Err`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --lib ssh_config_import` — Expected: new tests fail to compile.
- [ ] **Step 3: Implement** the structs, `preview`, `read_key` and the two commands; register `ssh_config_import::ssh_config_preview, ssh_config_import::ssh_config_read_key` in the `invoke_handler` list next to `keys::inspect_private_key` (`lib.rs` ~line 1728).
- [ ] **Step 4: Run** the same command — Expected: 12 passed; then `cargo test --lib` — Expected: all pass (146 + 12).
- [ ] **Step 5: Commit** `feat(ssh-import): resolve key files and add preview/read commands`

### Task 3: Let `createHost` take an id, skip the OS probe, and return the host

**Files:**
- Modify: `src/stores/hosts/hostStore.ts` (interface line ~53, `createHost` ~211–277)
- Test: `src/stores/hosts/hostStore.test.ts`

**Interfaces:**
- Produces: `createHost: (host: Partial<Host>, opts?: { probeOs?: boolean }) => Promise<Host | null>` — uses `host.id` when given (else `newId()`), calls `probeHostOs` only when `opts?.probeOs !== false`, returns the created `Host`, or `null` on failure (error still set in the store as today). Existing callers are unchanged.

- [ ] **Step 1: Write failing tests**: `createHost uses the given id and returns the host` (upsert mock receives `id: "h1"`, result `.id === "h1"`); `createHost skips the OS probe when probeOs is false` (`invoke` not called with `"ping_host_saved"`); `createHost returns null when no vault is selected`.
- [ ] **Step 2: Run** `npx vitest run src/stores/hosts/hostStore.test.ts` — Expected: 3 new failures.
- [ ] **Step 3: Implement** the signature change.
- [ ] **Step 4: Run** the same command — Expected: all pass; `npx tsc --noEmit -p .` passes.
- [ ] **Step 5: Commit** `feat(hosts): createHost accepts an id, can skip the OS probe, returns the host`

### Task 4: Import planner and executor (TypeScript, pure)

**Files:**
- Create: `src/lib/sshImport/sshImport.ts`, `src/lib/sshImport/sshImport.test.ts`

**Interfaces:**
- Consumes: `SshConfigPreview`/`SshConfigHost`/`SshConfigKey` shapes from Task 2 (mirror them as TS types here, camelCase).
- Produces (used by Task 5):
  - `type ImportRow = { alias, hostname, user, port, key: SshConfigKey | null, keyNote?: string, jumpAlias: string | null, jumpNote?: string, existing: boolean }`
  - `planSshImport(preview: SshConfigPreview, existingHostNames: string[]): ImportRow[]` — `existing` = alias matches an existing name (case-insensitive). `jumpAlias` = `proxyJump` when it is a single hop naming another row alias or an existing host name and that target's own `proxyJump` is empty; otherwise `null` with `jumpNote`: `"Jump chains aren't supported; imported without a jump host"` (multi-hop or target has its own jump) or `"Jump host <x> isn't in your config or Shetu"`. `keyNote` for `missing` → `"Key file not found; imported without a key"`, `unreadable` → `"Key file couldn't be read; imported without a key"`.
  - `runSshImport(rows: ImportRow[], passphrases: Record<string, string>, deps: ImportDeps): Promise<ImportSummary>` with
    `type ImportDeps = { groupId: string | null; existingKeys: { id: string; fingerprint?: string }[]; existingHosts: { id: string; name: string }[]; readKey(path: string): Promise<string>; importKey(k: { id: string; name: string; encryptedPrivateKey: string; passphrase?: string }): Promise<void>; createHost(h: Partial<Host>): Promise<Host | null>; newId(): string }`
    and `type ImportSummary = { hostsImported: number; keysImported: number; problems: { alias: string; message: string }[] }`.
    Order: ids for every row first (so `jumpHostId` can point at a row created later, or at `existingHosts` by name); keys once per distinct `key.path` — reuse an existing key with equal fingerprint, skip `missing`/`unreadable`, skip `encrypted` with an empty passphrase (problem: `"No passphrase given; imported without a key"`), otherwise `readKey` + `importKey` (a throw → problem with its message, hosts keep no key); then `createHost({ id, name: alias, address: hostname, port, username: user ?? "root", authType: keyId ? "key" : "password", keyId, jumpHostId, groupId: deps.groupId })` for each non-`existing` row (`null` → problem `"Couldn't create host"`).

- [ ] **Step 1: Write failing tests** (fakes for every dep):
  - `marks_existing_hosts` (case-insensitive), `single_hop_jump_linked`, `jump_chain_drops_outer_link` (A→B→C: A `jumpAlias null` + note, B `jumpAlias "C"`), `unknown_jump_target_noted`.
  - `same_key_file_imported_once`: two rows share a `ready` key path → `importKey` called once, both `createHost` calls get the same `keyId`, `authType "key"`.
  - `reuses_existing_key_by_fingerprint`: no `importKey` call; `keyId` = the existing key's id.
  - `wrong_passphrase_does_not_abort`: `importKey` rejects with `"bad passphrase"` → problem recorded, its host created with `authType "password"`, other rows still created.
  - `jump_host_id_points_to_row_or_existing`: `jumpHostId` equals the target row's pre-generated id, or the existing host's id.
  - `defaults_user_to_root`.
- [ ] **Step 2: Run** `npx vitest run src/lib/sshImport` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `planSshImport` and `runSshImport`.
- [ ] **Step 4: Run** the same command — Expected: all pass.
- [ ] **Step 5: Commit** `feat(ssh-import): plan and run the import`

### Task 5: Import dialog and button

**Files:**
- Create: `src/components/hosts/modals/SshConfigImportModal.tsx`, `src/components/hosts/modals/SshConfigImportModal.test.tsx`
- Modify: `src/components/hosts/panels/HostsPanel.tsx` (prop `onImport: () => void`, secondary **Import** button with `DownloadSimpleIcon` before **New Host** in the Hosts section header), `src/pages/HostsPage.tsx` (`useModal()` for the dialog, pass `onImport`, render `<SshConfigImportModal groupId={openGroup} onClose=… />`)

**Interfaces:**
- Consumes: `planSshImport`, `runSshImport`, types (Task 4); commands `ssh_config_preview`, `ssh_config_read_key` (Task 2); `useHostStore().createHost` with `{ probeOs: false }` (Task 3); `useKeyStore().importKey`, `.keys`; `Modal` from `@/components/ui/Modal`; `toast` from `sonner`.
- Produces: `export default function SshConfigImportModal({ groupId, onClose }: { groupId: string | null; onClose: () => void })`.

Behaviour (copy is fixed by the spec): title **"Import from SSH config"**; loading state while previewing; empty state **"No hosts found in ~/.ssh/config"**; when `ignoredMatchFiles` is non-empty a notice **"Match blocks aren't supported and were ignored in: <files>"**; one row per alias with a checkbox (checked by default, disabled with **"already in Shetu"** for `existing`), `user@hostname:port`, key file name, jump alias, and the row's note; one password input per distinct `encrypted` key path (label **"Passphrase for <file_name>"**); footer button **"Import N hosts and M keys"** (counts from checked rows / distinct importable keys) and **Cancel**. After the run: `toast.success("Imported N hosts and M keys")`; if `problems` is non-empty, keep the dialog open listing **"<alias>: <message>"** with a **Done** button, else close.

- [ ] **Step 1: Write failing tests** (`// @vitest-environment happy-dom`, mock `@tauri-apps/api/core` `invoke`, mock stores as in `hostStore.test.ts`): `shows empty state when no hosts`; `existing host row is disabled with "already in Shetu"`; `encrypted key shows one passphrase field per key file`; `import button reports counts and calls createHost with probeOs false`.
- [ ] **Step 2: Run** `npx vitest run src/components/hosts/modals` — Expected: FAIL (component missing).
- [ ] **Step 3: Implement** the modal, the button and the page wiring.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit -p .`, `npx biome lint .` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(hosts): import hosts from SSH config`

### Task 6: Verify in the running app

- [ ] **Step 1:** With `bun tauri dev` running from this worktree, open Hosts → **Import**; confirm the preview lists the user's real config hosts and nothing has been written yet (cancel).
- [ ] **Step 2:** Re-run the full suites: `npx vitest run`, `cd src-tauri && cargo test --lib` (with the `dist` placeholder) — Expected: all pass.
- [ ] **Step 3:** Push the branch and open the PR (title `feat(hosts): import hosts from ~/.ssh/config`, body: summary, decisions from the spec, test plan) — no attribution lines.
