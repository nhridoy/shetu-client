# Switcher Imports (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MobaXterm, SecureCRT, Tabby and iTerm2 as import sources in the existing Import dialog.

**Architecture:** One Rust adapter per source in `src-tauri/src/import/`, each returning the existing `ImportPreview` and wired into `preview_for`/`detect` in `import/mod.rs`. The frontend only gains four entries in `SOURCES` in `ImportModal.tsx`. The shared plan/run flow (groups, keys, jumps, summary) is unchanged.

**Tech Stack:** Rust: `quick-xml = "0.41"` and `plist = "1.10"` (both already in Cargo.lock via Tauri), `yaml-rust2 = "0.13"` (new; `serde_yml` is unmaintained), `serde_json`. Frontend: React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-switcher-imports-design.md` (Sources table, PR 2 rows)

## Global Constraints

- Same rules as PR 1: SSH sessions only, no passwords or other secrets, folders become groups, skipped entries listed with a reason, keys go through `describe_key` (network paths never opened), and every source file is read through `read_source_file` (5 MiB, opened once).
- Source ids: `mobaxterm`, `securecrt`, `tabby`, `iterm2`. Labels: "MobaXterm", "SecureCRT", "Tabby", "iTerm2".
- Only single-hop jump hosts are linked (Tabby `jumpHost`, iTerm2 `-J`). Gateways and other proxies are imported as a note in `skipped` (reason `"SSH gateway not imported"` / `"Proxy not imported"`).
- `biome check --write` only on changed files. No AI attribution in commits.

## Review Focus

- MobaXterm files are Windows‑1252, not UTF‑8 → non‑ASCII names decode correctly, not as `�` (Task 1 test `cp1252_names_decode`).
- SecureCRT `Identity Filename V2` values look like `C:\k\id_rsa.pub::rawkey` → private key path without `::rawkey` or `.pub` (Task 2).
- Tabby profiles that reference a group by id vs by name, and a `jumpHost` id that isn't in the file → name resolved, jump noted (Task 3).
- iTerm2 commands with quotes, extra flags (`-o X`, `-L a:b:c`), `ssh -l user host` and a trailing remote command → right host/user/port, no crash (Task 4).
- Malformed YAML/XML/JSON/plist picked by mistake → a clear `Err`, no panic (Tasks 2–4).

---

### Task 1: MobaXterm

**Files:**
- Create: `src-tauri/src/import/mobaxterm.rs`
- Modify: `src-tauri/src/import/mod.rs` (`read_source_file`: if bytes aren't valid UTF‑8 and have no BOM, decode as Windows‑1252 instead of lossy UTF‑8; dispatch + detect)

**Interfaces:**
- `fn parse(text: &str, origin: &str, home: &Path) -> ImportPreview` (source `mobaxterm`)
- `fn detected(home: &Path) -> Option<ImportPreview>`: Windows only, first existing of `dirs::document_dir()/MobaXterm/MobaXterm.ini` and `dirs::config_dir()/MobaXterm/MobaXterm.ini`. Picked file: `.mxtsessions` or `.ini`.
- Mapping: sections `[Bookmarks]` and `[Bookmarks_N]`; `SubRep` (backslash-separated) gives `folder`, empty = root; `ImgNum` ignored; every other `name=value` line is a session. Value starts `#<icon>#<type>%…`. Only type `0` with icon `109` is SSH; any other type is skipped as `"Not an SSH session"`. Fields are the `%`-split of the first `#`-group after the type: `[1]` host (required, else `"No host name"`), `[2]` port (default 22), `[3]` user (empty → none), `[8]` gateway host list (non-empty → note `"SSH gateway not imported"`), `[14]` key path (`_CurrentDrive_` → `C`, `_ProfileDir_` → `home`; empty → none). id = `folder/name`.

- [ ] **Step 1: Failing tests:** `ssh_session_fields` (host/port/user/key from a realistic line, `_CurrentDrive_:\keys\a.ppk` → `C:\keys\a.ppk`), `folders_from_subrep` (`Prod\Web` → `["Prod","Web"]`), `non_ssh_skipped` (`#91#4%…` RDP), `gateway_noted`, `profile_dir_expands`, and in `mod.rs` `cp1252_names_decode` (bytes `web-caf\xE9=…` read through `read_source_file` → `café`).
- [ ] **Step 2: Run** `cd src-tauri && cargo test -q --lib import::mobaxterm import::tests::cp1252` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -q --lib import` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): MobaXterm sessions with folders`

### Task 2: SecureCRT

**Files:**
- Create: `src-tauri/src/import/securecrt.rs`
- Modify: `src-tauri/Cargo.toml` (`quick-xml = "0.41"`), `import/mod.rs`

**Interfaces:**
- `fn parse_session_ini(name: &str, folder: Vec<String>, text: &str, out: &mut ImportPreview)`: lines `S:"Key"=value` (string) and `D:"Key"=hex` (dword). `Protocol Name` must be `SSH2` (or `SSH1`), else skipped `"<protocol> session"`. `Hostname` required. `[SSH2] Port` hex, default 22. `Username`. `Identity Filename V2`: strip `::rawkey`/anything after `::`, then a trailing `.pub` → `describe_key`. Firewall/jump settings (`Firewall Name` not `None`) → note `"Proxy not imported"`.
- `fn parse_sessions_dir(dir: &Path) -> ImportPreview`: walk recursively (depth ≤ 16); subfolder names become `folder`; skip `__FolderData__.ini` and `Default.ini`; read errors go to `skipped`.
- `fn parse_xml(text: &str, origin: &str) -> Result<ImportPreview, String>`: the "Export Settings" XML — the `<key name="Sessions">` subtree; nested `<key name>` = folders; a key with `<string name="Hostname">` is a session; values from `<string name>` / `<dword name>` children, mapped like the INI. Malformed XML → `Err("Couldn't read the SecureCRT export: …")`.
- Detect: `dirs::config_dir()/VanDyke/Config/Sessions` (Windows), `dirs::config_dir()/VanDyke/SecureCRT/Config/Sessions` (macOS), `~/.vandyke/SecureCRT/Config/Sessions` (Linux). Picked file: `.xml`.

- [ ] **Step 1: Failing tests:** `ini_session_fields` (incl. `D:"[SSH2] Port"=00000016`), `identity_rawkey_and_pub_stripped`, `telnet_skipped`, `dir_folders_and_folderdata_skipped`, `xml_export_nested_folders`, `malformed_xml_errors`.
- [ ] **Step 2: Run** `cargo test -q --lib import::securecrt` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -q --lib import` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): SecureCRT sessions from its config folder or XML export`

### Task 3: Tabby

**Files:**
- Create: `src-tauri/src/import/tabby.rs`
- Modify: `src-tauri/Cargo.toml` (`yaml-rust2 = "0.13"`), `import/mod.rs`

**Interfaces:**
- `fn parse(text: &str, origin: &str) -> Result<ImportPreview, String>` (source `tabby`): `profiles[]` with `type: ssh` (others skipped `"<type> profile"`, except `type: local`/`splash`-like built-ins, which are skipped silently). id = profile `id` (fallback `name`). `options.host` required; `options.port` default 22; `options.user`; `options.privateKeys[0]` with `file://` stripped (and percent-decoded) → key; `options.jumpHost` (a profile id) → `jump`. `group`: if it matches a `groups[].id`, use that group's `name`; otherwise use the value itself as the name; folder = `[name]` (Tabby groups are flat). Malformed YAML or no `profiles` list → `Err("Couldn't read the Tabby config: …")` / empty preview.
- Detect: `dirs::config_dir()/tabby/config.yaml`. Picked file: `.yaml`/`.yml`.

- [ ] **Step 1: Failing tests:** `ssh_profile_fields`, `group_by_id_or_name`, `jump_host_by_profile_id` (and an unknown id → row with `jump` set; the shared planner notes it), `non_ssh_skipped`, `malformed_yaml_errors`.
- [ ] **Step 2: Run** `cargo test -q --lib import::tabby` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -q --lib import` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): Tabby SSH profiles`

### Task 4: iTerm2

**Files:**
- Create: `src-tauri/src/import/iterm2.rs`
- Modify: `src-tauri/Cargo.toml` (`plist = "1.10"`), `import/mod.rs`

**Interfaces:**
- `fn parse_ssh_command(cmd: &str) -> Option<SshTarget { user: Option<String>, host: String, port: Option<u16>, key: Option<String>, jump: Option<String> }>`: whitespace split honouring single/double quotes; first word must end in `ssh`; flags `-p N`, `-l user`, `-i path`, `-J jump` (anything with a comma → no jump, caller notes it); flags that take an argument and are ignored: `-o -L -R -D -F -E -c -m -b -e -O -Q -S -W -w -B -I`; other `-x` flags skipped; first non-flag word = `[user@]host[:...]`; later words (remote command) ignored. `None` when no host.
- `fn parse_profiles(profiles: &[serde_json::Value], origin: &str) -> ImportPreview` (source `iterm2`): a profile counts when `"Custom Command"` is `"Yes"` (or the command starts with `ssh`) and its `Command` parses; others skipped silently (most are local shells). name = `Name`, id = `Guid`, `Tags` → tags, no folder. `-J` → `jump` = the jump string (matched by the planner to another row's id only if equal; otherwise noted).
- `fn parse_json(text: &str, origin: &str) -> Result<ImportPreview, String>`: `{"Profiles": [...]}` (the "Save all profiles as JSON" export and DynamicProfiles files).
- Detect (macOS only): `~/Library/Application Support/iTerm2/DynamicProfiles/*.json` plus `New Bookmarks` from `~/Library/Preferences/com.googlecode.iterm2.plist` (read with `plist`, converted to `serde_json::Value`). Picked file: `.json`.

- [ ] **Step 1: Failing tests:** `ssh_command_variants` (`ssh deploy@10.0.0.4`, `ssh -p 2222 -i "~/k a" web`, `ssh -l root -o StrictHostKeyChecking=no host uptime`, `ssh -J bastion inner`, `/usr/bin/ssh host`, `bash` → None), `json_profiles_mapped` (tags, name, guid), `non_ssh_profiles_skipped_silently`, `malformed_json_errors`.
- [ ] **Step 2: Run** `cargo test -q --lib import::iterm2` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -q --lib import` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): iTerm2 SSH profiles`

### Task 5: Sources in the Import dialog

**Files:**
- Modify: `src/components/hosts/modals/ImportModal.tsx` (`SourceId` + `SOURCES`), `src/components/hosts/modals/ImportModal.test.tsx`

**Interfaces:**
- New `SOURCES` entries, in this order after WinSCP: MobaXterm (`file: { name: "MobaXterm sessions", extensions: ["mxtsessions", "ini"] }`), SecureCRT (`{ name: "SecureCRT export", extensions: ["xml"] }`), Tabby (`{ name: "Tabby config", extensions: ["yaml", "yml"] }`), iTerm2 (`{ name: "iTerm2 profiles", extensions: ["json"] }`); Termius (CSV) stays last.

- [ ] **Step 1: Failing test:** the source step lists all eight labels, and "Choose iTerm2 file" opens with the `json` filter.
- [ ] **Step 2: Run** `npx vitest run src/components/hosts/modals/ImportModal.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `cd src-tauri && cargo test -q --lib` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(import): MobaXterm, SecureCRT, Tabby and iTerm2 in the Import dialog`
