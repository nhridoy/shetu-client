# Account Deletion — Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user schedule their account's deletion from Settings, reset every device that learns of it, offer Keep my account / Sign out on sign-in during the grace period, and warn teammates.

**Architecture:** Thin API functions over the server plan's endpoints; one `resetDevice()` that extends the existing sign-out teardown with settings, caches, logs and known-hosts; the session-revoked listener asks `account-status` before choosing reset vs. today's suspend; small UI pieces in Settings → Security, the sign-in screen and the team manager.

**Tech Stack:** React 19, TypeScript, zustand, Tauri v2 (Rust), `@tauri-apps/plugin-store`, vitest + happy-dom, cargo test.

**Repo:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish` (shetu-client), branch `feat/delete-account`. **Ships after the server plan** (`2026-11-13-delete-account-server.md`), whose endpoints it calls.

**Spec:** `docs/superpowers/specs/2026-11-13-delete-account-design.md`

## Global Constraints

- Server API (from the server plan): `POST /api/v1/me/deletion {proof, nonce, email}` → `{deletion_scheduled_for}`; `DELETE /api/v1/me/deletion` → 204; public `POST /api/v1/auth/account-status {user_id}` → `{status: "active"|"deletion_scheduled"|"deleted", deletion_scheduled_for?}`; `/me` and login responses include `deletion_scheduled_for` when scheduled; gated requests answer 403 `ACCOUNT_DELETION_SCHEDULED` / 410 `ACCOUNT_DELETED`.
- Plan decision carried from the server plan: the Rust HTTP layer (`src-tauri/src/http.rs`) is **not** changed; a rejected session triggers an `account-status` check instead.
- Nothing local is wiped unless the server confirmed (schedule succeeded, or status says scheduled/deleted).
- Copy (exact):
  - Danger area heading "Delete account"; button "Delete account…".
  - Dialog title "Delete your account?"; body lines: "Your vault, hosts, keys, snippets, port forwards and session history will be deleted." / for each owned team: "<Team name> (<n> members) — deleted for everyone" / "You have 30 days to change your mind — sign in again to cancel." / "Changes on your other devices that haven't synced yet will be lost."; fields "Password", "Type your email to confirm"; confirm button "Delete my account".
  - Errors: 404 → "Your server doesn't support account deletion yet."; 403 → "That password is incorrect."; 400 email → "That email doesn't match your account."
  - Sign-in screen notice: scheduled → "Your account will be deleted on <date>. Sign in to cancel."; deleted → "This account has been deleted."
  - Grace dialog: "Your account is scheduled for deletion on <date>." buttons "Keep my account" / "Sign out".
  - Team banner: "This team's owner is deleting their account. The team and its shared vault will be deleted on <date>."
  - Dates formatted with `toLocaleDateString(undefined, { dateStyle: "long" })`.
- Tests first; `npx vitest run`, `npx tsc --noEmit -p .`, `npx biome check <changed paths>` (never `--write` on all of `src`), `cargo test --manifest-path src-tauri/Cargo.toml` for Rust tasks (needs an empty `dist/`). No AI attribution.

## Review Focus

1. A transient network error while asking `account-status` must fall back to today's suspend (keep data), never reset — `revoked_session_with_status_error_suspends` (Task 4).
2. Requesting deletion while the server is down must not wipe anything or close the dialog — `request_failure_keeps_everything` (Task 5).
3. The email check must ignore case and surrounding spaces, as the server does — `email_match_ignores_case_and_spaces` (Task 6).
4. Reset must continue past a failing step (e.g. log file locked on Windows) and still sign out — `reset_continues_after_a_failing_step` (Task 3).
5. A team whose owner cancelled must lose the banner after the next sync (empty field clears it) — `banner_clears_when_owner_cancels` (Task 8).

---

### Task 1: API functions and types

**Files:** Modify `src/lib/api/auth.ts`; Test `src/lib/api/auth.test.ts` (create if absent; mock `apiFetch`'s transport the way neighbouring API tests do).

**Interfaces:**
- Produces: `User.deletion_scheduled_for?: string`; `authApi.requestAccountDeletion(body: { proof: string; nonce: string; email: string }): Promise<{ deletion_scheduled_for: string }>`; `authApi.cancelAccountDeletion(): Promise<void>`; `authApi.accountStatus(userId: string): Promise<{ status: "active" | "deletion_scheduled" | "deleted"; deletion_scheduled_for?: string }>`.

- [ ] **Step 1: Failing tests** `request_deletion_posts_proof_and_email`, `cancel_deletion_deletes`, `account_status_posts_user_id` — assert method, path, body.
- [ ] **Step 2: Run** `npx vitest run src/lib/api/auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `apiFetch`, mirroring `prelogin`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): API calls for account deletion`

---

### Task 2: Rust command to clear logs and known hosts

**Files:** Modify `src-tauri/src/ssh.rs` (KnownHosts clear), `src-tauri/src/logging.rs` or a new `src-tauri/src/device_reset.rs`, `src-tauri/src/lib.rs` (register).

**Interfaces:**
- Produces: `fn clear_dir_files(dir: &Path) -> Vec<String>` (deletes regular files directly inside `dir`, returns names it couldn't delete; missing dir → empty); `KnownHosts::clear(&mut self)` (empties memory and rewrites the file empty); command `reset_device_files(app, state) -> Result<Vec<String>, String>` (known hosts cleared + `clear_dir_files(app_log_dir)`; returns failures, never errors on a single file).

- [ ] **Step 1: Failing tests** `clear_dir_files_removes_files_and_reports_failures` (tempdir with files and a subdirectory: files gone, subdir kept), `clear_dir_files_missing_dir_is_empty`, `known_hosts_clear_empties_file_and_memory`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml clear_dir_files known_hosts_clear` — Expected: FAIL.
- [ ] **Step 3: Implement** and register the command.
- [ ] **Step 4: Run** same + full `cargo test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): clear logs and known hosts on device reset`

---

### Task 3: `resetDevice()`

**Files:** Create `src/lib/account/resetDevice.ts`; Modify `src/stores/auth/authStore.ts` (export `teardownSession` for reuse, or move it); Test `src/lib/account/resetDevice.test.ts`.

**Interfaces:**
- Consumes: Task 2 command `reset_device_files`.
- Produces: `async function resetDevice(): Promise<string[]>` — in order, each step in its own try/catch, collecting failure messages: `teardownSession()`; clear plugin-store files `settings.json` and `team-cache.json` (`load(f).clear()` + `save()`); `localStorage.clear()`; `invoke("reset_device_files")` (its returned names appended); reset in-memory stores (`useSettingsStore.getState().initSettings()`, `useShortcutStore.setState({ overrides: {} })`, theme store to its default via its existing init). Returns the failures (empty = clean).

- [ ] **Step 1: Failing tests** `reset_runs_every_step_in_order` (mocks record calls), `reset_continues_after_a_failing_step` (`reset_device_files` rejects → later steps still run, failure returned), `reset_clears_shortcut_overrides`.
- [ ] **Step 2: Run** `npx vitest run src/lib/account` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npx vitest run src/stores/auth` still PASS.
- [ ] **Step 5: Commit** `feat(account): reset this device completely`

---

### Task 4: Revoked session → status check

**Files:** Modify `src/stores/auth/authStore.ts` (the `onSessionRevoked` listener); Test `src/stores/auth/authStore.deletion.test.ts`.

**Interfaces:**
- Consumes: `authApi.accountStatus` (Task 1), `resetDevice` (Task 3).
- Produces: auth state `deletionNotice: { kind: "scheduled"; date: string } | { kind: "deleted" } | null`; `async function handleRevokedSession(): Promise<void>` — with a known user id: status `deletion_scheduled` → `resetDevice()` + notice scheduled; `deleted` → `resetDevice()` + notice deleted; `active`, unknown, or any error → existing `suspendServerSession()`.

- [ ] **Step 1: Failing tests** `revoked_session_for_scheduled_account_resets`, `revoked_session_for_deleted_account_resets`, `revoked_session_for_active_account_suspends`, `revoked_session_with_status_error_suspends` (status call rejects → suspend, `resetDevice` not called).
- [ ] **Step 2: Run** `npx vitest run src/stores/auth/authStore.deletion.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; the listener calls `handleRevokedSession`.
- [ ] **Step 4: Run** `npx vitest run src/stores/auth` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): devices wipe themselves when the account is being deleted`

---

### Task 5: Store actions — request, cancel, grace check

**Files:** Modify `src/stores/auth/authStore.ts`; Test `src/stores/auth/authStore.deletion.test.ts`.

**Interfaces:**
- Produces on the auth store: `requestAccountDeletion(password: string, email: string): Promise<void>` (prelogin → `deriveKek` → `computeLoginProof` exactly as `changePassword` does → API; on success `resetDevice()` and `deletionNotice = scheduled(date)`; on failure throws `Error` with the plan's copy and changes nothing); `cancelAccountDeletion(): Promise<void>` (API, then clears `pendingDeletion` and continues normal startup/sync); `pendingDeletion: string | null` set from `user.deletion_scheduled_for` after login and session restore.

- [ ] **Step 1: Failing tests** `request_success_resets_and_sets_notice`, `request_failure_keeps_everything` (API rejects → no reset, user still signed in, error copy), `request_maps_404_to_unsupported_server`, `login_with_scheduled_account_sets_pending_deletion`, `cancel_clears_pending_deletion`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/stores/auth` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): request and cancel account deletion`

---

### Task 6: Settings → Security danger area and dialog

**Files:** Create `src/components/settings/modals/DeleteAccountDialog.tsx` (or beside SecurityTab, following the folder's pattern); Modify `src/components/settings/tabs/SecurityTab.tsx` (danger area at the end); Test `src/components/settings/tabs/DeleteAccountDialog.test.tsx`.

**Interfaces:**
- Consumes: `requestAccountDeletion` (Task 5); `useTeamStore` teams (`ownerId`, `members`).
- Produces: danger area + dialog with the exact copy above; confirm disabled until password is non-empty and the typed email equals the account email ignoring case and surrounding spaces; errors shown inline; dialog stays open on error.

- [ ] **Step 1: Failing tests** `lists_owned_teams_with_member_counts` (only teams where `ownerId === user.id`), `confirm_disabled_until_email_matches`, `email_match_ignores_case_and_spaces`, `shows_server_error_and_stays_open`, `submits_password_and_email`.
- [ ] **Step 2: Run** `npx vitest run src/components/settings` — Expected: FAIL.
- [ ] **Step 3: Implement** using the existing `Modal`, `Button` (destructive variant) and input styles.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): delete account from Security`

---

### Task 7: Sign-in notice and grace-period dialog

**Files:** Create `src/components/auth/PendingDeletionDialog.tsx`; Modify `src/App.tsx` (render it like the recovery-code modal), the sign-in page component under `src/pages/auth/` (notice from `deletionNotice`); Test `src/components/auth/PendingDeletionDialog.test.tsx` and a sign-in notice test.

**Interfaces:**
- Consumes: `pendingDeletion`, `cancelAccountDeletion`, `logout`, `deletionNotice` (Tasks 4–5).

- [ ] **Step 1: Failing tests** `grace_dialog_shows_date_and_keeps_account` (Keep → `cancelAccountDeletion` called, dialog closes), `grace_dialog_sign_out_logs_out`, `sign_in_shows_scheduled_notice`, `sign_in_shows_deleted_notice`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The grace dialog can't be dismissed except by its two buttons.
- [ ] **Step 4: Run** `npx vitest run src/components/auth src/pages` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): keep or leave a scheduled account at sign-in`

---

### Task 8: Teammates' banner

**Files:** Modify `src-tauri/src/team_sync.rs` (`TeamWire.owner_deletion_scheduled_for: String` with `#[serde(default)]`), `src-tauri/src/db.rs` (`migrate_add_columns` entry `("team_records", "owner_deletion_scheduled_for", "TEXT NOT NULL DEFAULT ''")`, `TeamRecord` field, the `INSERT INTO team_records` / select), `src/stores/teams/teamStore.ts` (`Team.ownerDeletionScheduledFor?: string`, mapped from the record, `""` → undefined), `src/components/teams/managers/TeamManager.tsx` (banner per team); Tests: Rust `team_record_keeps_owner_deletion_date` in `db.rs` tests, vitest `teamStore.test.ts` mapping, `TeamManager` banner test.

- [ ] **Step 1: Failing tests** Rust: a snapshot with `owner_deletion_scheduled_for` is stored and listed; missing field → `""`. TS: `maps_owner_deletion_date`, `banner_shows_for_scheduled_owner`, `banner_clears_when_owner_cancels` (record with `""` → no banner).
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml team_record_keeps_owner_deletion_date` and `npx vitest run src/stores/teams src/components/teams` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both + full suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(teams): warn members when the owner is deleting their account`
