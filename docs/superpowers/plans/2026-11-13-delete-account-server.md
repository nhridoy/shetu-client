# Account Deletion — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user schedule deletion of their account (password proof + email), cancel it within 30 days, and have a daily job erase everything of theirs after that, leaving only a `deleted_accounts(user_id, deleted_at)` record.

**Architecture:** New `internal/account` package holds scheduling, cancellation, status, the purge and its loop. HTTP handlers live in `internal/auth/deletion.go` and reuse an extracted password-proof check. A `DeletionGate` middleware blocks a scheduled account's protected requests; a public `account-status` endpoint tells devices whose sign-in was rejected whether the account is scheduled or gone.

**Tech Stack:** Go, gin, GORM, glebarez/sqlite (tests), net/smtp.

**Repo:** `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/server` (shetu-server), branch `feat/account-deletion` from `main` (8d028f8).

**Spec:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish/docs/superpowers/specs/2026-11-13-delete-account-design.md`

## Global Constraints

- Grace period: exactly 30 days (`account.Grace = 30 * 24 * time.Hour`).
- Error codes (JSON `{"error":{"code",...}}` via `auth.Error`): `ACCOUNT_DELETION_SCHEDULED` (403, with `deletion_scheduled_for`), `ACCOUNT_DELETED` (410).
- Confirmation = password proof exactly as `HandlePasswordChange` checks it (`consumeLoginNonce` + `GenerateProof` + `ConstantTimeCompare`) **and** an email equal to the account email, case-insensitive.
- Never rely on DB cascades (SQLite foreign keys are off): the purge deletes every table explicitly.
- After the purge nothing references the user except `deleted_accounts(user_id, deleted_at)` — no email, no name.
- Email is best-effort; its failure never fails a request. Never log email addresses in the purge.
- Tests first; `go test ./...` and `go vet ./...` green before each commit. Conventional commits, no AI attribution.

### Plan decision (differs from the spec's mechanism, same outcome)

The spec had refresh return `ACCOUNT_DELETION_SCHEDULED` and the client's Rust HTTP layer pass it through. Refresh tokens are opaque and are deleted by the purge, so a device offline past day 30 cannot be mapped to its account that way. Instead: `POST /api/v1/auth/account-status {user_id}` (public, rate-limited) answers `active | deletion_scheduled | deleted`; the client asks it whenever its session is rejected. Refresh stays a plain 401. This also removes the need to change `src-tauri/src/http.rs`.

## Review Focus

1. A second "schedule" request while already scheduled must keep the original date (no extension by repeating) — `TestScheduleIsIdempotent` (Task 3).
2. A nonce from prelogin for a different email, or reused, must fail without scheduling — `TestScheduleRejectsReusedNonce` (Task 3).
3. A user not yet due (date in the future) must be untouched by the purge, including their teams — `TestPurgeSkipsUsersNotDue` (Task 6).
4. A scheduled user's teammates keep working: requests by **other** members of the owned team are not gated — `TestGateOnlyBlocksTheScheduledUser` (Task 4).
5. Purge interrupted halfway (error in one table) must leave the user fully intact, not half-deleted — `TestPurgeRollsBackOnError` (Task 6).

---

### Task 1: Schema — scheduled date and deleted-accounts record

**Files:**
- Modify: `internal/models/user.go` (add field), `internal/models/models.go` (AutoMigrate list)
- Create: `internal/models/deleted_account.go`
- Test: `internal/models/models_test.go`

**Interfaces:**
- Produces: `models.User.DeletionScheduledFor *time.Time` (`json:"deletion_scheduled_for,omitempty"`); `models.DeletedAccount{UserID uuid.UUID (primary key); DeletedAt time.Time}` with `TableName() "deleted_accounts"`.

- [ ] **Step 1: Failing test** `TestAutoMigrateCreatesDeletionSchema`: after `AutoMigrate` on in-memory SQLite, `db.Migrator().HasColumn(&models.User{}, "deletion_scheduled_for")` and `HasTable(&models.DeletedAccount{})` are true; a `User` with the field set round-trips; JSON of a user without it has no `deletion_scheduled_for` key.
- [ ] **Step 2: Run** `go test ./internal/models -run TestAutoMigrateCreatesDeletionSchema` — Expected: FAIL (undefined field/type).
- [ ] **Step 3: Implement** the field, the model, and add `&DeletedAccount{}` to the AutoMigrate list.
- [ ] **Step 4: Run** same — Expected: PASS; `go test ./...` PASS.
- [ ] **Step 5: Commit** `feat(account): schema for scheduled deletion and deleted accounts`

---

### Task 2: Reusable password-proof check

**Files:**
- Modify: `internal/auth/handlers.go` (`HandlePasswordChange` uses the helper)
- Create: `internal/auth/proof.go`
- Test: `internal/auth/proof_test.go`

**Interfaces:**
- Produces: `func verifyPasswordProof(db *gorm.DB, user *models.User, proofB64, nonceB64 string) (status int, code, message string)` — returns `status == 0` on success; otherwise exactly the statuses/codes/messages `HandlePasswordChange` returns today (401 `UNAUTHORIZED` "no verifier set" / "invalid old proof" / "invalid old nonce" / "invalid stored verifier"; 403 `FORBIDDEN` "current password is incorrect"). Consumes the nonce.

- [ ] **Step 1: Failing tests** in `proof_test.go` using `setupTestDB`, `seedUserWithVerifier`, `seedLoginNonce`: `TestVerifyPasswordProof_Valid` (status 0, nonce consumed: second call with same nonce → 401 "invalid old nonce"), `TestVerifyPasswordProof_WrongProof` (403 FORBIDDEN), `TestVerifyPasswordProof_NoVerifier` (401 "no verifier set").
- [ ] **Step 2: Run** `go test ./internal/auth -run TestVerifyPasswordProof` — Expected: FAIL (undefined).
- [ ] **Step 3: Implement** by extracting the inline block from `HandlePasswordChange`; make the handler call it. Behaviour of password change is unchanged.
- [ ] **Step 4: Run** `go test ./internal/auth` — Expected: PASS, including all existing `TestPasswordChange_*`.
- [ ] **Step 5: Commit** `refactor(auth): extract the password proof check`

---

### Task 3: Schedule and cancel endpoints (+ notice email)

**Files:**
- Create: `internal/account/account.go`, `internal/auth/deletion.go`
- Modify: `internal/email/sender.go` (extract `send(to, subject, html string) error`; add notice), `cmd/shetu-server/main.go` (routes), `internal/auth/handlers_test.go` (`setupHandlerRouter` registers the new routes)
- Test: `internal/account/account_test.go`, `internal/auth/deletion_test.go`, `internal/email/sender_test.go`

**Interfaces:**
- Produces (`account`): `const Grace = 30 * 24 * time.Hour`; `func Schedule(db *gorm.DB, userID uuid.UUID, now time.Time) (time.Time, error)` (sets date = now+Grace unless already set — then returns the existing date; revokes all the user's unrevoked refresh tokens); `func Cancel(db *gorm.DB, userID uuid.UUID) error` (clears the date).
- Produces (`auth`): `HandleRequestDeletion(db, cfg)` for `POST /api/v1/me/deletion`, body `{"proof","nonce","email"}` → 200 `{"data":{"deletion_scheduled_for": RFC3339}}`; `HandleCancelDeletion(db)` for `DELETE /api/v1/me/deletion` → 204.
- Produces (`email`): `func (s *Sender) SendAccountDeletionNotice(to string, on time.Time) error` — subject "Your Shetu account will be deleted", body says the date (`2 January 2006`) and "Sign in to Shetu before then to keep your account." `SendOtp` keeps its behaviour via `send`.

- [ ] **Step 1: Failing tests**
  - `account_test.go`: `TestScheduleSetsDateAndRevokesTokens` (date == now+30d; all refresh tokens revoked), `TestScheduleIsIdempotent` (second call at now+1h returns the first date), `TestCancelClearsDate`.
  - `deletion_test.go` (mirror `TestPasswordChange_ValidOldProof`): `TestRequestDeletion_Valid` (200, date in body, user row has date), `TestRequestDeletion_WrongProof` (403, no date), `TestRequestDeletion_EmailMismatch` (400 `VALIDATION_ERROR` "email does not match", no date, nonce **not** consumed), `TestRequestDeletion_EmailCaseInsensitive` (200), `TestScheduleRejectsReusedNonce` (second request with the same nonce → 401, still one date), `TestCancelDeletion` (204, date cleared).
  - `sender_test.go`: `TestSendAccountDeletionNotice_DisabledReturnsError` (no host, fallback off → error).
- [ ] **Step 2: Run** `go test ./internal/account ./internal/auth ./internal/email` — Expected: FAIL (undefined).
- [ ] **Step 3: Implement.** Handler order: bind → load user → compare email (before touching the nonce) → `verifyPasswordProof` → `account.Schedule` → `email.New(cfg.SMTP…).SendAccountDeletionNotice` only when `Enabled()`, error logged without the address → respond. Register both routes on `protected` in `main.go` and in `setupHandlerRouter`.
- [ ] **Step 4: Run** same + `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): schedule and cancel account deletion`

---

### Task 4: Deletion gate and account-status endpoint

**Files:**
- Create: `internal/auth/deletion_gate.go`
- Modify: `internal/account/account.go` (status), `internal/auth/deletion.go` (status handler), `cmd/shetu-server/main.go` (`protected.Use(..., auth.DeletionGate(db))` after `JWTMiddleware`; public route), `internal/auth/handlers_test.go` (`setupHandlerRouter` mirrors it)
- Test: `internal/auth/deletion_gate_test.go`, `internal/account/account_test.go`

**Interfaces:**
- Produces: `type Status string` with `StatusActive = "active"`, `StatusScheduled = "deletion_scheduled"`, `StatusDeleted = "deleted"`; `func GetStatus(db *gorm.DB, userID uuid.UUID) (Status, *time.Time, error)` (deleted iff a `deleted_accounts` row exists; scheduled iff the user's date is set; unknown IDs → active).
- Produces: `func DeletionGate(db *gorm.DB) gin.HandlerFunc` — for the current `user_id`: scheduled → 403 `ACCOUNT_DELETION_SCHEDULED` with `deletion_scheduled_for` (except `GET /api/v1/me` and `DELETE /api/v1/me/deletion`); deleted → 410 `ACCOUNT_DELETED`; otherwise next.
- Produces: `HandleAccountStatus(db)` for public `POST /api/v1/auth/account-status`, body `{"user_id"}` (invalid UUID → 400) → 200 `{"data":{"status", "deletion_scheduled_for"?}}`, behind `auth.RateLimit(cfg.RateLimitAuth)`.

- [ ] **Step 1: Failing tests**
  - `TestGateBlocksScheduledUser` (`POST /api/v1/sync/pull` stand-in route → 403 code `ACCOUNT_DELETION_SCHEDULED`, body has the date), `TestGateAllowsMeAndCancel` (`GET /me` 200 including `deletion_scheduled_for`; `DELETE /me/deletion` 204), `TestGateOnlyBlocksTheScheduledUser` (another user's request passes), `TestGateReportsDeletedAccount` (token for an ID in `deleted_accounts`, no user row → 410 `ACCOUNT_DELETED`).
  - `TestAccountStatus` table test: active, scheduled (with date), deleted, unknown → active, bad UUID → 400.
- [ ] **Step 2: Run** `go test ./internal/auth ./internal/account -run 'Gate|AccountStatus|GetStatus'` — Expected: FAIL.
- [ ] **Step 3: Implement**; one primary-key read per protected request (`SELECT deletion_scheduled_for FROM users WHERE id = ?`, falling back to `deleted_accounts` only when the user row is missing).
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): gate scheduled accounts and report account status`

---

### Task 5: Shared member-removal helper

**Files:**
- Modify: `internal/teams/sync.go` (`member.remove` case), `internal/teams/members.go` (REST remove)
- Create: `internal/teams/remove.go`
- Test: `internal/teams/remove_test.go`

**Interfaces:**
- Produces: `func RemoveMemberTx(tx *gorm.DB, teamID, userID uuid.UUID, now string) error` — sets the member's `state = "removed"` and the team's live vaults to `rotation_state = "rotation_required"`, `revision = revision + 1`, `updated_at = now`; no permission check (callers keep theirs). Both existing sites call it.

- [ ] **Step 1: Failing test** `TestRemoveMemberTx` (member state removed; each live team vault rotation_required with revision+1; deleted vaults untouched).
- [ ] **Step 2: Run** `go test ./internal/teams -run TestRemoveMemberTx` — Expected: FAIL.
- [ ] **Step 3: Implement** and switch both call sites.
- [ ] **Step 4: Run** `go test ./internal/teams ./internal/sync` — Expected: PASS (existing member-removal tests unchanged).
- [ ] **Step 5: Commit** `refactor(teams): share member removal`

---

### Task 6: Purge and its daily loop

**Files:**
- Create: `internal/account/purge.go`
- Modify: `cmd/shetu-server/main.go` (start the loop; cancel on shutdown)
- Test: `internal/account/purge_test.go`

**Interfaces:**
- Consumes: `teams.RemoveMemberTx` (Task 5), `teamsync.WithMutationBarrier` (`internal/sync/handlers.go`).
- Produces: `func PurgeDue(db *gorm.DB, now time.Time) (purged int, err error)` — each due user (`deletion_scheduled_for <= now`) in its own transaction inside `WithMutationBarrier`, re-checking the date inside; `func RunPurgeLoop(ctx context.Context, db *gorm.DB, every time.Duration)` — runs once immediately, then every `every` until `ctx` is done; logs `purged` counts with `slog`, never emails.

Purge order per user, all hard deletes:
1. Owned teams (`teams.owner_id = user`): their vaults' rows in `groups, hosts, keys, snippets, workspaces, presets, port_forwards, session_history, session_output_chunks, session_preferences, sync_changes, sync_operations, vault_key_envelopes, vault_rotations`; then `vaults`, `team_members`, `team_invites`, `team_sync_operations` for the team; then `teams`.
2. Other teams the user is an active member of: `RemoveMemberTx`, then delete that `team_members` row and `vault_key_envelopes` where `recipient_user_id = user`.
3. The user's own vaults (`vaults.owner_id = user`): same vault-scoped tables, then `vaults`.
4. `user_keys, refresh_tokens, auth_codes, team_sync_operations (user_id), team_invites (recipient_user_id or inviter_user_id), login_nonces (email)`.
5. `users` row; insert `deleted_accounts{UserID, DeletedAt: now}`.

- [ ] **Step 1: Failing tests** (helper `seedRichUser` builds: personal vault with a host, key, snippet, session history + output chunk, workspace; an owned team with another member, a shared vault with a host and an envelope, a pending invite; membership in a third party's team with a vault and an envelope; refresh token; user key; login nonce).
  - `TestPurgeRemovesEverything`: after `PurgeDue(db, due+1s)` → 1; for every table above, no row references the user, the owned team, or their vaults; `deleted_accounts` has the ID; the third-party team's vault is `rotation_required` and the user's membership row is gone; the other member of the owned team still has their user row.
  - `TestPurgeSkipsUsersNotDue`: date in the future → 0, nothing changed (row counts equal).
  - `TestPurgeRollsBackOnError`: force an error mid-purge (e.g. a `BEFORE DELETE` trigger on `users` that raises) → error returned, every seeded row still present.
  - `TestPurgeIsIdempotent`: second run → 0, no error.
  - `TestRunPurgeLoopRunsImmediately`: due user purged before the first tick; loop returns after `ctx` cancel.
- [ ] **Step 2: Run** `go test ./internal/account -run 'Purge'` — Expected: FAIL.
- [ ] **Step 3: Implement**; start `go account.RunPurgeLoop(ctx, db, 24*time.Hour)` in `main.go` after `AutoMigrate` with a `context.WithCancel` cancelled after `<-quit`.
- [ ] **Step 4: Run** `go test ./... && go vet ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(account): purge accounts after the grace period`

---

### Task 7: Warn teammates through team sync

**Files:**
- Modify: `internal/teams/sync.go` (`teamSyncSnapshot`)
- Test: `internal/teams/sync_test.go`

**Interfaces:**
- Produces: each entry of the snapshot's `teams` carries `owner_deletion_scheduled_for` (RFC3339) when the owner is scheduled, absent otherwise. Teams become `[]map[string]any` built from the existing models plus one batched `SELECT id, deletion_scheduled_for FROM users WHERE id IN (owner ids)`; every existing key keeps its name and value.

- [ ] **Step 1: Failing test** `TestTeamSyncSnapshotReportsOwnerDeletion` (mirror `TestTeamSyncSnapshotIncludesMemberAvatarURL`): owner scheduled → a member's snapshot team has `owner_deletion_scheduled_for`; after cancel it's absent; existing snapshot tests still pass.
- [ ] **Step 2: Run** `go test ./internal/teams -run TestTeamSyncSnapshotReportsOwnerDeletion` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(teams): tell members when the team owner is deleting their account`
