# Security Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-account security event history (Settings → Security → Recent activity) plus emails for risky events.

**Architecture:** One server helper `recordEvent` writes a `security_events` row at each event site (grouping failed attempts per account per hour) and sends the email for emailing kinds in the background. A protected list endpoint pages events newest first, joining device names at read time. The client renders the list in Settings.

**Tech Stack:** Go gin + GORM, sqlite tests; Tauri v2 + React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-security-events-design.md`

**Repos:** Tasks 1–3 in the server repo `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/server`, branch `feat/security-events` from `origin/main`; tests `go test ./...`. Tasks 4–5 in this client repo on `feat/security-events`; tests `npx vitest run`, `npx tsc --noEmit`, `npx biome check <changed files>` (never whole folders); lockfile is `bun.lock` (no new deps expected).

## Global Constraints

- Kinds (exact strings): `sign_in`, `sign_in_new_device`, `sign_in_failed`, `two_factor_failed`, `password_changed`, `recovery_used`, `two_factor_enabled`, `two_factor_disabled`, `backup_code_used`, `device_revoked`, `devices_revoked_others`, `deletion_scheduled`, `deletion_cancelled`.
- `sign_in` / `sign_in_new_device` detail: `password` | `google` | `github` (OAuth: the user's `auth_provider`).
- Emailing kinds: `sign_in_new_device`, `password_changed`, `recovery_used`, `device_revoked`, `devices_revoked_others`, `two_factor_failed` (only when a new grouped row is inserted), `two_factor_enabled`, `two_factor_disabled`, `backup_code_used`. Deletion kinds keep their existing deletion email and add none.
- Grouped kinds: `sign_in_failed`, `two_factor_failed`: same user + kind with `created_at` within the last hour → `count+1`, `last_at`, `ip` = latest, distinct IPs (cap 20) → `ip_count`.
- Recording never fails or delays a request: errors are logged (`slog.Warn`), emails go in a goroutine via the existing sender.
- Retention 90 days; account purge deletes events.
- New device = valid UUID device id with no `devices` row for the user before this sign-in; an account with no `devices` rows at all → `sign_in`, no email. Invalid/empty device id → `sign_in`, no email.
- Wrong two-factor code = verify refused with `errCodeInvalid` or `errCodeReused` (TOTP, backup or email code). Expired/used-up/locked challenges record nothing.
- Email wording for `two_factor_failed` by path: login "Someone entered your password but not your two-factor code."; oauth "Someone signed in with Google/GitHub but not your two-factor code."; recovery "Someone used your recovery code but not your two-factor code." Every security email ends with "If this wasn't you, change your password and sign out your other devices in Shetu."
- `recovery_used` detail "all devices signed out"; `two_factor_disabled` detail "email" when via the recovery email fallback.
- API `GET /me/security-events?before=<id>&limit=<n>`: newest first (by id desc), default 50, max 100, `{events, next}`; event `{id, kind, detail, device_name, platform, ip, count, ip_count, created_at, last_at, current_device}`.
- Client copy (exact): section title "Recent activity"; top line "Something you don't recognise? Sign out that device in Devices and change your password."; empty "No activity yet"; error "Couldn't load recent activity." + "Retry"; "Show more"; badge "This device"; titles per the spec's table; unknown kind "Account activity"; grouped suffix "(N× from M addresses)" (omit "from M addresses" when M = 1).
- No Claude/AI attribution in commits.

## Review Focus

1. A sign-in on a device id that exists for **another** account → still "new device" for this account (lookup is per user). (Task 2 test `TestEvents_NewDeviceIsPerAccount`.)
2. A failed password for an email with no account, or with a malformed proof/nonce → nothing recorded, response unchanged. (Task 2 test `TestEvents_FailedLoginUnknownEmailRecordsNothing`.)
3. The 21st distinct IP in one grouped row → count still increments, `ip_count` stops at 20 without error. (Task 1 test `TestEvents_GroupedIPsCapAt20`.)
4. Recording failure (events table missing) → the sign-in or change still succeeds. (Task 2 test `TestEvents_RecordingFailureNeverBlocks`.)
5. A device later renamed or revoked → its old events show the current name; an event whose device row is gone shows no name, not an error. (Task 1 test `TestEvents_ListJoinsCurrentDeviceName`.)

---

### Task 1: Server — model, recordEvent, emails, list API, retention

**Files:**
- Create: `internal/models/security_event.go`, `internal/auth/events.go`, `internal/auth/events_test.go`
- Modify: `internal/models/models.go` (AutoMigrate), `internal/email/sender.go`, `internal/purge/purge.go` (+ test), `cmd/shetu-server/main.go`, `internal/auth/handlers_test.go` (test router)

**Interfaces:**
- Produces:
  - `models.SecurityEvent{ID uint, UserID uuid.UUID (index, cascade), Kind string, Detail string, DeviceID string, IP string, IPs string (comma list, grouped rows), IPCount int (default 1), Count int (default 1), CreatedAt time.Time, LastAt time.Time}`, table `security_events`, index `(user_id, created_at)`.
  - `recordEvent(c *gin.Context, db *gorm.DB, cfg *config.Config, userID uuid.UUID, kind, deviceID, detail string)`: IP from `c.ClientIP()`; groups the two grouped kinds; emails emailing kinds (looks up the user's email). Exported test hook `var deliverSecurityNotice = func(cfg *config.Config, to, kind, detail, ip string, at time.Time)` (default: background `SendSecurityNotice`).
  - `(*email.Sender).SendSecurityNotice(to, kind, detail, ip string, at time.Time) error` (replaces `SendTwoFactorNotice`; same two-factor wording; `two_factor_disabled` + detail `email` = the old `disabled_by_email` text; `two_factor_failed` text by detail `login|oauth|recovery`).
  - `HandleListSecurityEvents(db *gorm.DB) gin.HandlerFunc` on `GET /me/security-events`.
  - `purge.PurgeOldSecurityEvents(db *gorm.DB, now time.Time) (int64, error)` called by `RunPurgeLoop` each pass; `&models.SecurityEvent{}` in the account purge's step-4 list.
- [ ] **Step 1: Failing tests** (`events_test.go`; capture emails via the hook):
  - `TestEvents_RecordAndList`: three events → list returns them newest first with all fields; `current_device` true only for the caller's device id.
  - `TestEvents_Paging`: 120 events → default page 50 + `next`; `before=next` continues; `limit=500` → 100.
  - `TestEvents_GroupingWithinAnHour`: two `sign_in_failed` from IPs A, B → one row `count 2, ip_count 2, ip B`; a row whose `created_at` is 61 minutes old → a new row.
  - `TestEvents_GroupedIPsCapAt20`.
  - `TestEvents_TwoFactorFailedEmailsOncePerHour`: two `two_factor_failed` → one email; after an hour → a second.
  - `TestEvents_EmailingKindsOnly`: `sign_in` sends nothing, `password_changed` sends one with the IP.
  - `TestEvents_ListJoinsCurrentDeviceName`.
  - `TestEvents_OnlyOwnEvents`: another user's events never listed.
  - Purge: `TestPurgeOldSecurityEvents` (91-day-old row gone, 89-day kept); the account purge test seeds and checks `security_events`.
- [ ] **Step 2:** `go test ./internal/auth -run TestEvents_ && go test ./internal/purge` → FAIL (undefined).
- [ ] **Step 3:** implement; move two-factor notices onto `SendSecurityNotice` (keep `notifyTwoFactor` call sites compiling until Task 3, or switch them now; builder's call); register the route in `main.go` and the test router.
- [ ] **Step 4:** → PASS; `go test ./...` ok.
- [ ] **Step 5:** commit `feat(events): security event log, list API and retention`.

### Task 2: Server — sign-in events

**Files:**
- Modify: `internal/auth/devices.go`, `internal/auth/handlers.go` (register, login, verify-email), `internal/auth/oauth.go` (exchange, setup), `internal/auth/twofactor_signin.go` (`issueSignIn`, `finishOAuthCallback`, verify)
- Test: `internal/auth/events_signin_test.go`

**Interfaces:**
- Consumes: Task 1 `recordEvent`.
- Produces: `recordSignIn(c *gin.Context, db *gorm.DB, cfg *config.Config, userID uuid.UUID, deviceID, method string)`: decides new/first device **before** calling `recordDevice(db, userID, deviceID, true)`, then records `sign_in_new_device` or `sign_in`. It replaces every `recordDevice(..., true)` call (6 sites). `issueSignIn` gains a `method string` parameter (login → `password`; verify on an `oauth` challenge → the user's `auth_provider`).
- Failed attempts: `HandleLogin` records `sign_in_failed` (device id empty) only where the proof check fails for an existing user with a verifier and a consumed nonce; verify records `two_factor_failed` with detail = challenge path on `errCodeInvalid`/`errCodeReused`.
- [ ] **Step 1: Failing tests:**
  - `TestEvents_LoginRecordsSignIn` (detail `password`, device id, IP).
  - `TestEvents_NewDeviceEmailsOnce`: second device → `sign_in_new_device` + email; same device again → `sign_in`, no email.
  - `TestEvents_FirstDeviceIsNotNew`: brand-new account's first sign-in → `sign_in`, no email.
  - `TestEvents_NewDeviceIsPerAccount`.
  - `TestEvents_NoDeviceIdIsNeverNew`.
  - `TestEvents_OAuthSignInDetail`: callback and exchange record detail `google`.
  - `TestEvents_TwoFactorVerifyRecordsSignIn`: login challenge verified → one `sign_in` event (none at challenge time).
  - `TestEvents_FailedLoginGrouped`: 3 wrong proofs → one `sign_in_failed` row `count 3`, no email.
  - `TestEvents_FailedLoginUnknownEmailRecordsNothing`.
  - `TestEvents_WrongTwoFactorCodeRecordedAndEmailed`: wrong code on a login challenge → `two_factor_failed` detail `login` + one email; expired challenge → nothing new.
  - `TestEvents_RecordingFailureNeverBlocks`.
  - Existing auth tests stay green.
- [ ] **Step 2:** `go test ./internal/auth -run TestEvents_` → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `go test ./...` ok.
- [ ] **Step 5:** commit `feat(events): record sign-ins, new devices and failed attempts`.

### Task 3: Server — account-change events

**Files:**
- Modify: `internal/auth/handlers.go` (password change, recovery), `internal/auth/twofactor_settings.go` (confirm, disable, regenerate, `verifySecondFactor`), `internal/auth/twofactor_signin.go` (verify backup use), `internal/auth/devices.go` (revoke one/others), `internal/auth/deletion.go` (schedule/cancel), `cmd/shetu-server/main.go` + test router (handlers that now need `cfg`)
- Test: `internal/auth/events_account_test.go`

**Interfaces:**
- Consumes: Task 1.
- Changes: `verifySecondFactor` stops emailing; callers record `backup_code_used` when it returns `usedBackup = true`. `notifyTwoFactor` is deleted. `HandleRevokeDevice`, `HandleRevokeOtherDevices`, `HandleCancelDeletion` take `(db, cfg)`.
- Device id for these events: the caller's `c.GetString("device_id")`; recovery: empty.
- [ ] **Step 1: Failing tests:** one per event, each asserting the row and whether an email was sent:
  - `TestEvents_PasswordChanged` (email);
  - `TestEvents_RecoveryUsed` (detail "all devices signed out", email);
  - `TestEvents_TwoFactorEnabledDisabled` (both email);
  - `TestEvents_BackupCodeUsed` (via disable and via sign-in verify; email);
  - `TestEvents_RecoveryEmailFallbackDisables` (`two_factor_disabled` detail `email`, email);
  - `TestEvents_DeviceRevoked` (detail = that device's name, or "Unnamed device"; email);
  - `TestEvents_OthersRevoked` (detail = count; email);
  - `TestEvents_DeletionScheduledCancelled` (rows, no new email);
  - the existing two-factor tests stay green.
- [ ] **Step 2:** `go test ./internal/auth -run TestEvents_` → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `go test ./...`, `go vet ./...`, `gofmt -l internal cmd` clean.
- [ ] **Step 5:** commit `feat(events): record password, recovery, two-factor, device and deletion changes`.

### Task 4: Client — API

**Files:**
- Create: `src/lib/api/securityEvents.ts`, `src/lib/api/securityEvents.test.ts`

**Interfaces:**
- Produces: `interface SecurityEvent { id: number; kind: string; detail: string; device_name: string; platform: string; ip: string; count: number; ip_count: number; created_at: string; last_at: string; current_device: boolean }`; `securityEventsApi.list(before?: number): Promise<{ events: SecurityEvent[]; next: number | null }>` (`GET /api/v1/me/security-events` with `?before=` when given), using the same request helper style as `devices.ts`.
- [ ] **Step 1: Failing test:** path without and with `before`; returns the data; a server error throws its message.
- [ ] **Step 2:** `npx vitest run src/lib/api/securityEvents.test.ts` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `npx tsc --noEmit`.
- [ ] **Step 5:** commit `feat(events): client API`.

### Task 5: Client — Settings → Security → Recent activity

**Files:**
- Create: `src/components/settings/tabs/RecentActivity.tsx` (+ test)
- Modify: `src/components/settings/tabs/SecurityTab.tsx`

**Interfaces:**
- Consumes: Task 4.
- Produces: `eventTitle(e: SecurityEvent): string` (exported for tests) and the `RecentActivity` component, wired into `SecurityTab` under its own "Recent activity" heading only when `serverAuthenticated`, after Devices.
- Row: icon (`WarningIcon` for `sign_in_failed`/`two_factor_failed`, otherwise `ShieldCheckIcon`, from `@phosphor-icons/react`), title, detail line (device name + platform label as `DevicesSettings` formats it, IP, grouped suffix), relative time via `formatRelativeTime` (of `last_at` for grouped rows), "This device" badge when `current_device`.
- [ ] **Step 1: Failing tests:** titles for every kind (table in the spec) incl. `· Google`; unknown kind "Account activity"; grouped suffix with and without addresses; "Show more" appends the next page and disappears when `next` is null; empty and error (Retry) states; the top hint line.
- [ ] **Step 2:** `npx vitest run src/components/settings/tabs/RecentActivity.test.tsx` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; full `npx vitest run`, `npx tsc --noEmit`, biome on changed files.
- [ ] **Step 5:** commit `feat(events): Recent activity in Settings`.
