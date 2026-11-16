# Switcher Imports (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Import dialog for ssh_config, PuTTY, WinSCP and Termius CSV (folders → groups, keys incl. `.ppk`), plus host export as ssh_config or CSV.

**Architecture:** Rust `import` module: one model (`ImportPreview`), one adapter per source, three commands (`import_detect`, `import_preview`, `import_read_key`) and `export_hosts`. The existing `sshImport` lib generalises to plan/run any preview (creating groups first). `SshConfigImportModal` becomes `ImportModal` with a source step.

**Tech Stack:** Rust (Tauri v2, `csv` crate new, `winreg` new on Windows only, existing `ssh2-config`, `russh`), React 19, zustand, vitest, plugin-dialog + plugin-fs.

**Spec:** `docs/superpowers/specs/2026-11-16-switcher-imports-design.md`

## Global Constraints

- Sources in this PR: `ssh_config`, `putty`, `winscp`, `termius_csv`. No passwords/secrets imported. SSH-family sessions only.
- Folders → nested groups under the dialog's group, reusing a group with the same name + parent.
- Duplicate = same host name already in that row's target group (case-insensitive). Unchecked + marked "exists".
- Missing user → host created without username (ssh_config keeps `root` default as today).
- Only single-hop jump hosts linked; otherwise a summary note.
- Key reads only for keys the source's preview lists (`ready`/`encrypted`). Files read ≤ 64 KiB for keys; source files ≤ 5 MiB.
- Export: no passwords/keys/TOTP. CSV header `label,address,port,username,group,tags`, tags joined `;`, group path joined `/`, RFC 4180 via `csv`. ssh_config: `Host`, `HostName`, `User`, `Port`, `ProxyJump`, effective (inherited) values, names with spaces quoted, `# key: <name>` comment instead of `IdentityFile`.
- `biome check --write` only on changed files. No AI attribution in commits.

## Review Focus

- `.reg` export saved by regedit is UTF‑16LE with BOM and CRLF → parses the same as UTF‑8 (Task 2 test `reg_utf16_bom_crlf`).
- Percent-encoded and non-ASCII session names (`My%20Server`, `%C3%A9`) → decoded names (Tasks 2, 3).
- A huge or binary file picked by mistake → clear error, no panic, no hang (Task 1 test `picked_file_over_limit_is_refused`).
- Two folders with the same name under different parents → two groups, not merged (Task 5 test).
- CSV with UTF‑8 BOM, quoted commas, and blank lines → parsed (Task 4 test `termius_csv_bom_quotes_blank_lines`).

---

### Task 1: Import model, ssh_config source, commands

**Files:**
- Create: `src-tauri/src/import/mod.rs` (model, `describe_key` moved here with `.ppk` support, `read_source_file`, commands)
- Modify: `src-tauri/src/ssh_config_import.rs` (add `pub(crate) fn to_preview(home) -> Result<ImportPreview, String>`; keep its tests), `src-tauri/src/lib.rs` (register `import::import_detect`, `import::import_preview`, `import::import_read_key`; keep the old two commands until Task 6)

**Interfaces:**
- Produces (serde camelCase):
  - `ImportPreview { source: String, origin: String, hosts: Vec<ImportedHost>, skipped: Vec<Skipped> }`
  - `ImportedHost { id: String, name: String, hostname: String, port: u16, user: Option<String>, key: Option<ImportKey>, jump: Option<String> /* another row's id */, folder: Vec<String>, tags: Vec<String> }`
  - `Skipped { name: String, reason: String }`; `ImportKey` = today's `SshConfigKey` shape (path, fileName, status, fingerprint, keyType)
  - `fn describe_key(path: &Path) -> ImportKey` (`.ppk`: header `PuTTY-User-Key-File-`; `Encryption: none` → convert via `keys::convert_ppk_inner` then fingerprint, status `ready`; otherwise `encrypted`, no fingerprint)
  - `fn read_source_file(path: &Path) -> Result<String, String>` (regular file ≤ 5 MiB; UTF‑16LE/BE BOM decoded; UTF‑8 BOM stripped)
  - `#[tauri::command] import_detect() -> Vec<Detected { source, origin }>`
  - `#[tauri::command] import_preview(source: String, path: Option<String>) -> Result<ImportPreview, String>` (unknown source → `Err("Unknown import source")`)
  - `#[tauri::command] import_read_key(source: String, path: Option<String>, key_path: String) -> Result<String, String>` — stateless: re-runs `import_preview(source, path)` and reads only a listed `ready`/`encrypted` key (≤ 64 KiB); returns the raw file text
- `fn preview_for(source: &str, path: Option<&Path>, home: &Path) -> Result<ImportPreview, String>` dispatch used by both commands (testable without Tauri).

- [ ] **Step 1: Failing tests** in `import/mod.rs`:
  - `ssh_config_maps_to_model`: temp home with `Host web\n HostName 10.0.0.4\n User deploy\n Port 2222\nHost app\n ProxyJump web` → hosts `web` (id `web`, port 2222, user `deploy`, folder `[]`) and `app` with `jump == Some("web")`; a `Match` file appears in `skipped` with the existing wording.
  - `ppk_unencrypted_is_ready_with_fingerprint` / `ppk_encrypted_is_encrypted` (fixtures: reuse the `.ppk` builders from `keys.rs` tests).
  - `read_key_refuses_unlisted_path`: `import_read_key` logic with a path not in the preview → `Err`.
  - `picked_file_over_limit_is_refused`: 5 MiB + 1 byte file → `Err` mentioning the size; a directory → `Err`.
  - `utf16_bom_is_decoded`: `read_source_file` on `FF FE` + UTF‑16LE "a=b" → `"a=b"`.
  - `unknown_source_errors`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --lib import::` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module. Move `describe_key`/`read_small_file` from `ssh_config_import.rs` into `import` and call them from there.
- [ ] **Step 4: Run** `cargo test --lib import:: ssh_config_import::` — Expected: PASS (existing ssh_config tests unchanged).
- [ ] **Step 5: Commit** `feat(import): one import model with ssh_config as the first source`

### Task 2: PuTTY source

**Files:**
- Create: `src-tauri/src/import/putty.rs`, `src-tauri/src/import/ini.rs` (`fn sections(text: &str) -> Vec<(String, Vec<(String, String)>)>`: `[name]` headers, `key=value`, `;`/`#` comments, trims, keeps order), `src-tauri/src/import/encoding.rs` (`fn percent_decode(s: &str) -> String`, lossless for invalid sequences)
- Modify: `src-tauri/Cargo.toml` (`[target.'cfg(windows)'.dependencies] winreg = "0.55"` or current), `import/mod.rs` (dispatch + detect)

**Interfaces:**
- `fn parse_reg(text: &str) -> ImportPreview` (sections under `...\SimonTatham\PuTTY\Sessions\<name>`; values `"K"="v"` and `"K"=dword:hex`)
- `fn parse_sessions_dir(dir: &Path) -> ImportPreview` (one file per session, file name = encoded name, lines `Key=Value`)
- `#[cfg(windows)] fn read_registry() -> Option<ImportPreview>`
- Detect: Windows registry key exists, else `~/.putty/sessions` has files. Picked file: `.reg`.
- Mapping: name = decoded session name; skip `Default Settings`; `Protocol` ≠ `ssh` → skipped `"<Protocol> session"`; `HostName` empty → skipped `"No host name"`; `user@host` in HostName splits; `UserName`; `PortNumber` (dword) default 22; `PublicKeyFile` → `describe_key`; folder `[]`; id = name.

- [ ] **Step 1: Failing tests** in `putty.rs`: `reg_maps_ssh_sessions` (two sessions incl. `My%20Server`, dword port `00000016`=22 and `0000115c`=4444, key path), `reg_skips_default_and_non_ssh` (reasons `"telnet session"`, `"serial session"`), `reg_user_in_hostname`, `reg_utf16_bom_crlf` (encode the same text UTF‑16LE + BOM + CRLF through `read_source_file`), `sessions_dir_maps_files`, `non_ascii_name_decoded` (`%C3%A9` → `é`).
- [ ] **Step 2: Run** `cargo test --lib import::putty` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --lib import::` — Expected: PASS. `cargo check` clean (non-Windows build skips `winreg`).
- [ ] **Step 5: Commit** `feat(import): PuTTY sessions from the registry, ~/.putty or a .reg file`

### Task 3: WinSCP source

**Files:**
- Create: `src-tauri/src/import/winscp.rs`
- Modify: `import/mod.rs` (dispatch + detect)

**Interfaces:**
- `fn parse_ini(text: &str) -> ImportPreview` (sections `Sessions\<encoded path>`), `#[cfg(windows)] fn read_registry() -> Option<ImportPreview>` (`HKCU\Software\Martin Prikryl\WinSCP 2\Sessions`)
- Detect: registry, else `dirs::config_dir()/WinSCP.ini` (Windows only). Picked file: `.ini`.
- Mapping: decoded path split on `/` → `folder` = all but last, name = last; `FSProtocol` absent or `0|1|2` keep, else skipped `"FTP/WebDAV/S3 session"`; `HostName` (required), `UserName`, `PortNumber` default 22, `PublicKeyFile` (percent-decoded) → key; `Tunnel=1` → host imported, plus skipped-style note `{ name, reason: "Tunnel host not imported" }`; id = full path.

- [ ] **Step 1: Failing tests:** `ini_maps_folders` (`Sessions\Prod/Web/web%2D1` → folder `["Prod","Web"]`, name `web-1`), `ini_skips_ftp` (`FSProtocol=5`), `ini_decodes_key_path` (`C:%5Ckeys%5Ca.ppk` → `C:\keys\a.ppk`), `ini_tunnel_noted`, `ini_ignores_non_session_sections` (`[Configuration\Interface]`).
- [ ] **Step 2: Run** `cargo test --lib import::winscp` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --lib import::` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): WinSCP sites with folders`

### Task 4: Termius CSV import and host export

**Files:**
- Create: `src-tauri/src/import/termius_csv.rs`, `src-tauri/src/export.rs`
- Modify: `src-tauri/Cargo.toml` (`csv = "1"`), `import/mod.rs` (dispatch; never detected), `src-tauri/src/lib.rs` (register `export::export_hosts`)

**Interfaces:**
- `fn parse_csv(text: &str) -> Result<ImportPreview, String>`: header aliases (case-insensitive, trimmed): name ← `label|name|alias|title`; hostname ← `hostname|address|ip|host` (missing column → `Err("The CSV has no address column")`); `port`; user ← `username|user|login`; group ← `group|folder` (split `/`, trimmed, empty parts dropped); tags ← `tags|tag` (split on `,`/`;`); `protocol` column present → keep rows where it's empty or `ssh`, others skipped `"<protocol> row"`. Row without address → skipped `"No address"`. Name defaults to the address. id = `row<N>`.
- `#[tauri::command] export_hosts(vault_id: String, group_id: Option<String>, format: String) -> Result<String, String>` with testable `fn export(db, crypto, vault_id, group_id: Option<&str>, format) -> Result<String, String>`: hosts in that group subtree (all when `None`), sorted by group path then name; effective `username`/`port` from `host_inherit::defaults` when the host has none; `ProxyJump` = the jump host's name if it's in the vault; `# key: <key name>` when the host has a key.

- [ ] **Step 1: Failing tests:**
  - `termius_csv_aliases_and_groups` (header `Label,IP,Port,Username,Group,Tags`; `Prod/Web`; tags `a;b` and `a, b`).
  - `termius_csv_bom_quotes_blank_lines` (BOM, `"web, primary"` label, blank line).
  - `termius_csv_protocol_filter`, `termius_csv_requires_address_column`.
  - `export_csv_round_trips` (export a fixture vault → `parse_csv` gives the same names/addresses/ports/users/group paths/tags).
  - `export_ssh_config_effective_values` (host without user under a group with `username: "deploy"` → `User deploy`; name `my web` → `Host "my web"`; jump → `ProxyJump <name>`; output contains no `"password"`/key text).
  - `export_group_subtree_only`.
  - Use the `fixture()`, `host_in`, `group_with` helpers from `ssh_route.rs` tests (make them `pub(crate)` in a `#[cfg(test)]` module if needed).
- [ ] **Step 2: Run** `cargo test --lib import::termius_csv export::` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --lib` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): Termius CSV import and host export as ssh_config or CSV`

### Task 5: Shared import plan/run (frontend lib + store)

**Files:**
- Modify: `src/lib/sshImport/sshImport.ts` → rename to `src/lib/import/hostImport.ts` (move test too), `src/stores/hosts/hostStore.ts` (`createGroup` returns `Promise<Group | null>`; update `GroupForm` caller only if types require)
- Test: `src/lib/import/hostImport.test.ts` (existing ssh_config cases kept, adapted to the new model)

**Interfaces:**
- Types mirror Task 1 (`ImportPreview`, `ImportedHost`, `ImportKey`, `Skipped`).
- `planImport(preview: ImportPreview, ctx: { rootGroupId: string | null; groups: { id: string; name: string; parentId?: string | null }[]; hosts: { name: string; groupId?: string | null }[] }): ImportRow[]` — `ImportRow` = today's row + `id`, `folder: string[]`, `tags: string[]`, `existing` computed against the resolved target group (a folder group that doesn't exist yet → never existing); `jumpAlias` → `jumpId` (row id).
- `runImport(rows, passphrases, deps): Promise<ImportSummary>`; `deps` = today's `ImportDeps` + `createGroup(g: { name: string; parentId: string | null }): Promise<{ id: string } | null>`, `groups` (existing), `convertPpk(text: string, passphrase?: string): Promise<string>`; `readKey(path)` unchanged signature (the modal binds source/path).
- Order: groups (parent before child, reuse by name + parent, case-insensitive) → keys (`PuTTY-User-Key-File-` text goes through `convertPpk` first) → hosts (jump targets first). `username` = `row.user ?? undefined` except source `ssh_config` keeps `?? "root"`. `tags` passed through.

- [ ] **Step 1: Failing tests:** `folders_become_nested_groups_and_are_reused` (existing `Prod` under root reused, `Prod/Web` created once for two hosts), `same_name_folders_under_different_parents_stay_apart`, `duplicate_only_within_target_group` (`web` exists at root but row targets `Prod` → not existing), `ppk_key_is_converted_before_import`, `missing_user_left_empty_except_ssh_config`, `jump_links_by_row_id`, plus the existing ssh_config cases.
- [ ] **Step 2: Run** `npx vitest run src/lib/import` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/import src/stores/hosts` and `npx tsc --noEmit` — Expected: PASS / clean.
- [ ] **Step 5: Commit** `feat(import): plan and run any source, folders as groups`

### Task 6: Import dialog with source step; remove the old commands

**Files:**
- Rename: `src/components/hosts/modals/SshConfigImportModal.tsx` → `ImportModal.tsx` (+ test)
- Modify: `src/pages/HostsPage.tsx`, `src-tauri/src/lib.rs` + `ssh_config_import.rs` (remove `ssh_config_preview`, `ssh_config_read_key` commands)

**Interfaces:**
- Consumes Task 1 commands, Task 5 `planImport`/`runImport`.
- `ImportModal({ groupId, onClose })`. Source step: rows "SSH config", "PuTTY", "WinSCP", "Termius (CSV)"; detected ones show "Found: <origin>" + **Import**; every source except SSH config shows **Choose file…** (`open()` with filters: PuTTY `reg`, WinSCP `ini`, Termius `csv`). Preview step: today's table + **Folder** column (`Prod / Web`, "—" for none) + "Skipped" list (name — reason). `readKey` bound to `invoke("import_read_key", { source, path, keyPath })`. Back button returns to the source step.

- [ ] **Step 1: Failing tests** (adapt existing modal tests): source step lists the four sources with "Found" for detected ones; Choose file calls `open` with the source's filter and previews with that path; folder column and skipped list render; import creates the group then the host inside it (mock store deps); Back returns to sources.
- [ ] **Step 2: Run** `npx vitest run src/components/hosts/modals` — Expected: FAIL.
- [ ] **Step 3: Implement**; remove the old commands and their registrations.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `cd src-tauri && cargo test --lib` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(import): one Import dialog for ssh_config, PuTTY, WinSCP and Termius CSV`

### Task 7: Export button

**Files:**
- Create: `src/components/hosts/modals/ExportModal.tsx` (+ test)
- Modify: `src/components/hosts/panels/HostsPanel.tsx` (Export button beside Import, `onExport` prop), `src/pages/HostsPage.tsx`

**Interfaces:**
- `ExportModal({ groupId, groupName, onClose })`: two choices "SSH config" / "CSV"; calls `invoke<string>("export_hosts", { vaultId, groupId, format: "ssh_config" | "csv" })`, then `save({ defaultPath: "shetu-hosts.conf" | "shetu-hosts.csv" })` and `writeTextFile(path, text)`; cancel in the save dialog → nothing written, modal stays; success → toast "Exported to <file name>" and close; error → message in the modal.

- [ ] **Step 1: Failing tests:** each format invokes with the right args and writes the returned text to the picked path; cancelled save writes nothing; error shown.
- [ ] **Step 2: Run** `npx vitest run src/components/hosts/modals/ExportModal.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit` — Expected: PASS / clean.
- [ ] **Step 5: Commit** `feat(export): export hosts as ssh_config or CSV`
