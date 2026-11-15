# Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reusable identities (label + username + optional password, key and TOTP secret) synced per vault, picked by hosts and groups as their login, with TOTP codes auto-filled at login.

**Architecture:**
- The server gains a vault-scoped `identities` table following the snippets pattern.
- In the client, Rust stores and syncs identities, resolves `authType: "identity"` in the existing inheritance chain, and generates TOTP codes at prompt time.
- The frontend adds a Keychain page (Keys | Identities), an identity modal with a live TOTP preview, and an "Identity" login choice with a picker.

**Tech Stack:**
- Server: Go (gin, GORM).
- Client: Rust (Tauri v2, russh, `hmac`/`sha1`), React 19 + zustand + react-hook-form/zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-identities-design.md` (read "Calls made after the builder check").

**Repos / branches:**
- Server: `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/server`, new branch `feat/identities` from local `main` (abd0750). The network was flaky during planning; fetch first if possible.
- Client: `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/identities` (on top of the PR #33 content, 4eaf7e3).

## Global Constraints

- **Identity row:** plain `name` (label), `sort_order`, plus the standard sync columns. Encrypted `data` holds `{ username, password?, keyId?, totpSecret? }`. Nothing secret goes in plain columns.
- **Host/group reference:** stored in the encrypted host/group data as `identityId`, with host row `auth_type: "identity"` and group payload `authType: "identity"`. No server host/group schema change.
- **Resolution:**
  - The identity resolves as one unit; its username wins outright over any host or group username.
  - It must be in the host's vault and not deleted; otherwise it counts as unset and falls back.
  - An unusable identity key (deleted or other vault) is dropped alone.
- **TOTP:**
  - RFC 6238, HMAC-SHA1 by default (SHA256/SHA512 per an otpauth URI), 6 digits by default (8 if specified), 30 s period by default.
  - The secret is base32 (spaces and case ignored) or an `otpauth://totp/...` URI.
- **TOTP auto-fill:**
  - A keyboard-interactive round with exactly one prompt whose text matches `/(verification|one[- ]?time|otp|token|authenticator|2fa|two[- ]factor|code)/i` gets the current code, once per `login` call (per hop).
  - A rejected code means later rounds go to the dialog.
  - Code prompts never get the password.
- **Connect-time save:** identity hosts (direct or inherited) never offer "Save to this host", and the username is never asked.
- **Copy:**
  - Login option "Identity".
  - Picker entry "+ New identity".
  - Login line "Identity '{label}' · {group}" when inherited, "Identity '{label}'" when direct.
  - Page title "Keychain" with tabs "Keys" / "Identities".
  - Delete confirm "Used by {n} hosts and {m} groups. They'll ask for a login when connecting." (pluralise correctly; omit when 0 and 0).
- **Secrets:** the TOTP secret and codes, and identity passwords, are never logged and never sent to the frontend for saved identities. The only exception is `totp_preview`, which receives the value being typed.
- **Older clients:** no version gate; they see unknown auth as "no saved login".
- **Checks:**
  - Server: `go test ./...`.
  - Client: `mkdir -p dist && cd src-tauri && cargo test`; `bunx vitest run`; `bunx tsc --noEmit`; `bunx biome check <changed files>` (never `--write` on folders; never `cargo fmt` the whole crate).
  - No AI attribution.

## Review Focus

1. **Existing hosts not on Identity resolve exactly as before.** Pinned by the Task 4 test `non_identity_hosts_unchanged`.
2. **A team host can't use a personal-vault identity, even through a group.** Pinned by the Task 4 test `identity_from_other_vault_is_ignored`.
3. **A "Password:" prompt never receives a TOTP code, and a code prompt never receives the password.** Pinned by the Task 3 tests `totp_only_for_code_prompts` and `password_not_sent_to_code_prompt`.
4. **Deleting an identity in use leaves its hosts connectable via "Ask when connecting", with no crash or stale identity name in the form.** Pinned by the Task 4 test `deleted_identity_falls_back` and the Task 7 test `host form with a deleted identity shows Ask when connecting`.
5. **Account deletion purges identities, and team rotation re-encrypts them.** Pinned by the Task 1 tests.

---

### Task 1: Server — `identities` table

**Files (server repo):**
- Create `internal/models/identity.go`.
- Modify:
  - `internal/models/models.go` (AutoMigrate list);
  - `internal/models/timestamps.go` (`"identities": {"created_at","updated_at","deleted_at"}`);
  - `internal/sync/validation.go` (`"identities": {}`);
  - `internal/sync/handlers.go` (the table list at ~203 and any other table switch);
  - `internal/teams/rotation.go` (`rotationTables` + switch case);
  - `internal/purge/purge.go` (`vaultScoped`).
- Tests: extend `internal/sync/handlers_types_test.go`, `internal/models/models_test.go`, `internal/purge/purge_test.go`, and the rotation tests (find them with `grep -rn rotationTables internal`).

**Interfaces:** Produces the `identities` sync table with the snippet-like columns minus description and tags. The JSON field names match the other tables.

- [ ] **Step 1: Write failing tests:**
  - sync push then pull of an identities row round-trips (name, data, sort_order);
  - the schema test lists the table;
  - rotation re-encrypts identities rows;
  - account purge deletes a user's identities (explicit delete, since foreign keys are off on SQLite).
- [ ] **Step 2: Run** `go test ./...` — Expected: FAIL.
- [ ] **Step 3: Implement** following `Snippet` exactly, minus Description and Tags.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): add identities as a synced vault table`

### Task 2: Client Rust — local table, sync, TS table name

**Files:**
- Modify:
  - `src-tauri/src/db.rs` (`Table::Identities`, CREATE TABLE, the column lists at ~31/1731/1891/1939/2117/2133/3045 — follow every `"snippets"`/`Table::Snippets` occurrence);
  - `src-tauri/src/sync_db.rs` (~52 optional columns `&[]`, ~665 table list);
  - `src-tauri/src/team_sync.rs`, if it lists tables for rotation or re-encryption (grep);
  - `src/lib/db/db.ts` (`TableName` gains `"identities"`).
- Tests: db/sync_db Rust tests.

**Interfaces:**
- Produces `crate::db::Table::Identities`, string `"identities"`, and encryption AAD `"identities"`.
- Produces `get_sync_row(db, Table::Identities, id)` (same as other tables).

- [ ] **Step 1: Write failing tests:**
  - upsert + get an identities row;
  - a sync push payload includes identities;
  - a pull applies identities;
  - the wipe/purge path (the delete-account `resetDevice` and `wipe_all`) clears identities (grep `wipe_all`).
- [ ] **Step 2: Run** `cargo test` — Expected: FAIL.
- [ ] **Step 3: Implement.** If pulling from an older server without the table errors, make it degrade quietly; check how sync handles an unknown or absent table.
- [ ] **Step 4: Run** `cargo test` and `bunx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): store and sync identities locally`

### Task 3: Client Rust — TOTP generation, preview command, login auto-fill

**Files:**
- Create `src-tauri/src/totp.rs`.
- Modify `src-tauri/src/ssh.rs` (add `SshConfig.totp: Option<crate::totp::TotpParams>`, default `None` everywhere a config is built), `src-tauri/src/ssh_auth.rs` (keyboard-interactive step), `src-tauri/src/lib.rs` (command), and `src-tauri/Cargo.toml`: move `sha1` from dev-dependencies to dependencies; add `sha2` (check the lockfile for an existing version) and base32 decoding (a local fn or `data-encoding` as a direct dependency, already in the lockfile).

**Interfaces:**
- Produces:
  - `pub struct TotpParams { secret: Vec<u8>, algorithm: Sha1|Sha256|Sha512, digits: u32, period: u64 }`;
  - `pub fn parse(input: &str) -> Result<TotpParams, String>` (base32 or otpauth URI);
  - `pub fn code(p: &TotpParams, unix_secs: u64) -> String`;
  - `#[tauri::command] totp_preview(value: String) -> Result<{ code: String, secondsLeft: u64 }, String>`.
- `SshConfig.totp`; `ssh_auth::login` uses it. Login tests build `SshConfig` with `totp: Some(..)` directly (resolution comes in Task 4).

- [ ] **Step 1: Write failing tests:**
  - RFC 6238 vectors: SHA1 secret "12345678901234567890" at T=59 → 8-digit "94287082"; plus 1111111109, 1111111111 and 1234567890; SHA256/SHA512 vectors.
  - `parse` accepts lowercase base32 with spaces, and an otpauth URI with `algorithm`/`digits`/`period`; it rejects garbage.
  - ssh_auth tests:
    - `totp_auto_fills_code_prompt` ("Verification code:" → current code, once);
    - `totp_only_for_code_prompts` ("Password:" with an identity that has TOTP but no password → prompter);
    - `password_not_sent_to_code_prompt`;
    - `rejected_code_goes_to_dialog`;
    - `password_then_code_chain`.
- [ ] **Step 2: Run** `cargo test` — Expected: FAIL.
- [ ] **Step 3: Implement.** Use an injectable clock in `login` tests (e.g. a `now` field on the config or context) so codes are deterministic.
- [ ] **Step 4: Run** `cargo test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ssh): generate TOTP codes and fill server code prompts from identities`

### Task 4: Client Rust — identity resolution, `identity_usage`, inherited defaults

**Files:** Modify `src-tauri/src/host_inherit.rs` (resolve + `inherited_host_defaults`), `src-tauri/src/ssh.rs` (`load_host_config`, `SshConfig.totp`) and `src-tauri/src/lib.rs` (register commands). Tests go in `host_inherit` mod tests and `ssh_route.rs` mod tests (reuse `fixture`, `host_with`/`host_in`, `group_with`, plus a new `identity_with(db, crypto, id, vault, payload, deleted)` helper encrypting with AAD `"identities"`).

**Interfaces:**
- Consumes `Table::Identities` (Task 2), `crate::totp::{TotpParams, parse}` and `SshConfig.totp` (Task 3).
- Produces:
  - Fills `SshConfig.totp` from the identity's `totpSecret` via `crate::totp::parse` (Task 3); an unparsable stored secret means `None`.
  - `#[tauri::command] identity_usage(identity_id: String, vault_id: String) -> { hosts: u32, groups: u32 }`.
  - `inherited_host_defaults` gains `identityName`, `identityFrom` and `identityUsername` (never password or TOTP).

- [ ] **Step 1: Write failing tests:**
  - `host_on_identity_uses_its_login`: username, password, key and totp are all taken from the identity.
  - `identity_username_wins_over_host_and_group`.
  - `group_identity_inherited_as_unit`.
  - `identity_from_other_vault_is_ignored`.
  - `deleted_identity_falls_back` (to ask/none, or to the group).
  - `identity_key_unusable_drops_key_only`.
  - `non_identity_hosts_unchanged`.
  - `identity_usage_counts_hosts_and_groups` (local rows in the vault, not deleted).
  - `defaults_include_identity_name_not_secrets`.
- [ ] **Step 2: Run** `cargo test` — Expected: FAIL.
- [ ] **Step 3: Implement.** The identity row's `name` is the label.
- [ ] **Step 4: Run** `cargo test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ssh): resolve identities as host and group logins`

### Task 5: Frontend — identity store

**Files:** Create `src/stores/identities/identityStore.ts` + test. Modify `src/stores/hosts/hostStore.ts` only if shared helpers (e.g. `runSerial`) must be exported.

**Interfaces:** Produces `useIdentityStore` with:
- `identities: Identity[]`, where `Identity = { id, name, vaultId, sortOrder, createdAt, data? }` (no secrets in list state);
- `fetchIdentities(vaultId?)`;
- `getDecryptedIdentity(id): Promise<{ username, password?, keyId?, totpSecret? } | null>`;
- `createIdentity({ name, username, password?, keyId?, totpSecret?, vaultId })`;
- `updateIdentity(id, patch): Promise<boolean>`, which merges the encrypted payload, is serialized per id, and treats an empty password as "keep";
- `deleteIdentity(id)`.

- [ ] **Step 1: Write failing tests:** create stores secrets only in plaintext; update merge keeps unpatched fields; an empty password on update keeps the stored one; list state has no secrets; delete tombstones.
- [ ] **Step 2: Run** the focused vitest — Expected: FAIL.
- [ ] **Step 3: Implement**, mirroring keyStore/hostStore patterns.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(identities): store for reusable logins`

### Task 6: Frontend — Keychain page and identity modal

**Files:** Modify `src/pages/KeysPage.tsx` (tabs). Create `src/components/identities/IdentityList.tsx`, `src/components/identities/IdentityModal.tsx` and tests. Check the sidebar label/route for Keys (`AppSidebar`) and rename the visible label to "Keychain".

**Interfaces:**
- Consumes the Task 5 store, the Task 4 `identity_usage` and the Task 3 `totp_preview`.
- Produces `<IdentityModal identity? onClose onSaved(id) />`, used by Task 7.

- [ ] **Step 1: Write failing tests:**
  - tabs Keys/Identities, and the identity list shows label and username;
  - the modal validates label and username as required, and the key picker is limited to the current vault;
  - editing with an empty password keeps the stored one;
  - TOTP: pasting an otpauth URI shows a preview code (mock `totp_preview`) and its seconds-left countdown;
  - an invalid secret shows "Not a valid TOTP secret";
  - delete confirm shows the exact usage copy (mock `identity_usage` → 3/1), or the plain confirm when 0/0.
- [ ] **Step 2: Run** the focused vitest — Expected: FAIL.
- [ ] **Step 3: Implement** in the key modals' style. The preview refreshes every second while the modal is open.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: PASS.
- [ ] **Step 5: Commit** `feat(identities): Keychain page with identities and TOTP preview`

### Task 7: Frontend — "Identity" login choice for hosts and groups

**Files:** Modify:
- `src/components/hosts/forms/CredentialsFields.tsx`;
- `src/components/hosts/forms/HostForm.tsx` and `GroupForm.tsx` (submit mapping: `authType "identity"` + `identityId` in the payload; the host username is hidden but its stored value is not cleared);
- `src/lib/schema/hosts/hostFormSchema.ts` and `groupFormSchema.ts` (`identityId` required when authType is identity);
- `src/stores/hosts/hostStore.ts` (payload field `identityId`, sanitizer);
- `src/lib/hosts/inherited.ts` + `inheritedLabels.ts` (identity login line);
- `src/lib/terminal/agentForwarding.ts` / `pendingCredentials.ts` (no Save and no username ask for identity hosts);
- plus tests.

**Interfaces:** Consumes the Task 5 store, the Task 6 `IdentityModal`, and Task 4's `identityName`/`identityFrom`/`identityUsername`.

- [ ] **Step 1: Write failing tests:**
  - Login options include "Identity" for hosts and groups. Choosing it shows a picker of current-vault identities plus "+ New identity", which opens the modal; on save the new identity is selected.
  - The host Username field is hidden while Identity is chosen. The submit maps to `authType: "identity"` + `identityId`.
  - The inherited login line reads "Identity 'deploy' · prod".
  - `host form with a deleted identity shows Ask when connecting` (identityId not found in the store).
  - A connect for an identity host never asks for a username, and the password prompt shows no Save.
  - The hostStore sanitizer keeps `identityId` as a string, else null.
- [ ] **Step 2: Run** the focused vitest — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosts): hosts and groups can log in with an identity`

### Task 8: Manual check

- [ ] Run `bun run tauri dev` and check:
  1. Create an identity with a TOTP URI; the preview matches an authenticator app.
  2. Point a host at it; it connects with the identity's login; a 2FA server code fills itself.
  3. Point a group at it; a host on "From group" uses it.
  4. Delete the identity; the warning count is right, and the host asks for a login.
- [ ] Anything not run (no live 2FA server) goes in the PR bodies as untested.
