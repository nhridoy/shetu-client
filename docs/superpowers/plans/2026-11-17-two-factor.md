# Two-factor sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional TOTP two-factor with backup codes, checked on password, OAuth and recovery sign-in, with an email fallback on recovery only.

**Architecture:** The server answers a passed first factor for a two-factor account with `401 TWO_FACTOR_REQUIRED` + a challenge (OAuth: `dest=two_factor`); `POST /auth/two-factor` turns challenge + code into exactly the response the first factor would have given. The client's existing sign-in flows pause on that error, show a code form, and resume with the verified response.

**Tech Stack:** Go gin + GORM (`github.com/pquerna/otp`), sqlite tests; Tauri v2 + React 19 + zustand, vitest; `qrcode` npm package.

**Spec:** `docs/superpowers/specs/2026-11-17-two-factor-design.md`

**Repos:** Tasks 1–4 run in the server repo `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/server` on branch `feat/two-factor` from `origin/main`. Tasks 5–7 run in this client repo on `feat/two-factor`. Server tests: `go test ./...`. Client tests: `npx vitest run`, `npx tsc --noEmit`, `npx biome check <changed files>` (never whole folders).

## Global Constraints

- TOTP: SHA-1, 6 digits, 30-second step, ±1 step accepted; a step at or before the last accepted step is refused.
- 10 backup codes, shown once, stored hashed (sha256, base64 raw), single use.
- Challenge: random, stored hashed, single use, 5 minutes (recovery: 15), bound to user, device id and path (`login` | `oauth` | `recovery`), 5 code attempts then void.
- Recovery proof: single use, valid 10 minutes, required by `POST /auth/recovery` for a two-factor account.
- Email codes reuse `auth_codes` (`otpTTL` 15 min, `maxOtpAttempts` 5) with purposes `two_factor_setup` and `two_factor_recovery`.
- Email code only on recovery challenges; never on login/OAuth.
- `TWO_FACTOR_KEY`: 32 bytes, base64 (std). Missing/invalid → server starts, two-factor unavailable; accounts with two-factor on fail closed on login/OAuth; the recovery email path still works.
- Secrets sealed with AES-256-GCM (random 12-byte nonce prepended, base64 std).
- Error codes/messages (exact):
  - `TWO_FACTOR_REQUIRED` 401 "Enter your two-factor code. Update Shetu if you don't see a code field." with `challenge` beside `code`/`message` in the error object (same as `VERIFICATION_REQUIRED` carries `email`).
  - `TWO_FACTOR_INVALID` 401 "That code isn't right."
  - `TWO_FACTOR_CODE_REUSED` 401 "This code was just used. Wait for the next code."
  - `TWO_FACTOR_EXPIRED` 401 "Start signing in again."
  - `TWO_FACTOR_UNAVAILABLE` 503 "Two-factor isn't available on this server."
- Turning two-factor on never signs out other devices. Emails are best effort, never block.
- Client copy: code screen title "Two-factor code"; field label "6-digit code"; links "Use a backup code" / "Use your authenticator"; recovery-only link "Lost your authenticator? Email me a code"; setup tick "I saved these backup codes".
- No Claude/AI attribution in commits.

## Review Focus

1. Double submit of the same challenge (two requests at once) → exactly one succeeds; the challenge `used_at` / attempts update must be a conditional UPDATE, not read-then-write. (Task 3 test `TestTwoFactor_ChallengeSingleUseUnderRace`.)
2. Codes typed with spaces or dashes ("123 456", "abcd-efgh") and backup codes in either case → accepted after normalisation. (Task 1 test `TestNormalizeCode`.)
3. Account deletion/purge leaves two-factor rows behind → purge deletes them. (Task 2 extends the purge test.)
4. Two-factor turned off on another device while a challenge is open → verify returns `TWO_FACTOR_EXPIRED` ("Start signing in again"); the next sign-in has no second step. (Task 3 test `TestTwoFactor_DisabledMidChallengeExpires`.)
5. Cancelling the code screen → the sign-in form is usable again (not stuck loading) and a late verify can't resume the cancelled sign-in. (Task 6 test "cancel returns to the form".)

---

### Task 1: Server — model, key, TOTP and backup-code primitives

**Files:**
- Create: `internal/models/two_factor.go`, `internal/auth/twofactor_crypto.go`, `internal/auth/twofactor_crypto_test.go`
- Modify: `internal/models/models.go` (AutoMigrate), `internal/config/config.go`, `go.mod`

**Interfaces:**
- Produces:
  - `models.TwoFactor{UserID uuid.UUID (pk, cascade), Secret string, PendingSecret string, EnabledAt *time.Time, LastStep int64, CreatedAt, UpdatedAt}`, table `two_factors`.
  - `models.TwoFactorBackupCode{ID uint, UserID uuid.UUID (index, cascade), CodeHash string, UsedAt *time.Time, CreatedAt}`, table `two_factor_backup_codes`.
  - `models.TwoFactorChallenge{ID uint, TokenHash string (unique), UserID uuid.UUID (index, cascade), DeviceID string, Path string, Attempts int, ExpiresAt time.Time, UsedAt *time.Time, DisableTwoFactor bool, CreatedAt}`, table `two_factor_challenges` (also stores recovery proofs with `Path = "recovery_proof"`).
  - `cfg.TwoFactorKey []byte` (nil when unset/invalid; logged once at startup).
  - `sealSecret(key []byte, plain string) (string, error)`, `openSecret(key []byte, sealed string) (string, error)`.
  - `matchTOTP(secret, code string, now time.Time, lastStep int64) (step int64, err error)` → `errCodeInvalid` | `errCodeReused`.
  - `newBackupCodes() (plain []string, hashes []string, err error)`: 10 codes, 8 lowercase base32 chars formatted `xxxx-xxxx`.
  - `normalizeCode(s string) string`: strip spaces and dashes, lowercase.
  - `hashCode(s string) string`: sha256 of normalised code, base64 raw std.
  - `var nowFunc = time.Now` (tests pin time).

- [ ] **Step 1: Failing tests** in `twofactor_crypto_test.go`:
  - `TestSealOpenRoundTrip`: open(seal(x)) == x; two seals of x differ; open with another key errors.
  - `TestMatchTOTP`: with a secret from `totp.Generate`, a code for `now` matches and returns `now.Unix()/30`; codes for `now±30s` match; `now±60s` → `errCodeInvalid`; same code with `lastStep` = its step → `errCodeReused`.
  - `TestNewBackupCodes`: 10 unique codes matching `^[a-z2-7]{4}-[a-z2-7]{4}$`; `hashCode(strings.ToUpper(c))` equals the returned hash.
  - `TestNormalizeCode`: `"123 456"`→`"123456"`, `"ABCD-efgh"`→`"abcdefgh"`.
  - `TestConfigTwoFactorKey`: `TWO_FACTOR_KEY` unset → nil; non-base64 or not 32 bytes → nil; valid → 32 bytes.
- [ ] **Step 2:** `go test ./internal/auth ./internal/config -run 'Seal|MatchTOTP|BackupCodes|NormalizeCode|TwoFactorKey'` → FAIL (undefined).
- [ ] **Step 3:** `go get github.com/pquerna/otp`; implement. `matchTOTP` loops steps −1..+1 using `totp.GenerateCodeCustom` (Period 30, Digits 6, SHA1) with `subtle.ConstantTimeCompare`; code normalised first.
- [ ] **Step 4:** same command → PASS; `go test ./...` → ok.
- [ ] **Step 5:** commit `feat(two-factor): secret sealing, TOTP matching and backup codes`.

### Task 2: Server — settings endpoints and notice emails

**Files:**
- Create: `internal/auth/twofactor_settings.go`, `internal/auth/twofactor_settings_test.go`
- Modify: `internal/email/sender.go`, `cmd/shetu-server/main.go`, `internal/purge/purge.go` (+ its test)

**Interfaces:**
- Consumes: Task 1.
- Produces (protected routes):
  - `GET /me/two-factor` → `{enabled, available, backup_codes_left, email_verified}`.
  - `POST /me/two-factor/setup` → `{otpauth_url, secret, email_code_sent}`; stores a sealed `PendingSecret` (issuer `Shetu`, account = email); when `EmailVerifiedAt == nil` also issues and sends a `two_factor_setup` email code. Refuses with `TWO_FACTOR_UNAVAILABLE` when `cfg.TwoFactorKey == nil`; 409 `TWO_FACTOR_ENABLED` when already on.
  - `POST /me/two-factor/confirm {code, email_code?}` → `{backup_codes: [10]}`; checks the pending secret (sets `LastStep`), and the email code when the email is unverified (sets `EmailVerifiedAt`); moves pending → `Secret`, sets `EnabledAt`, replaces backup codes, sends the "turned on" notice.
  - `POST /me/two-factor/disable {code}` → 204; accepts a TOTP or backup code (`verifySecondFactor`), deletes the two-factor row and backup codes, sends "turned off".
  - `POST /me/two-factor/backup-codes {code}` → `{backup_codes}`; replaces the set.
  - `verifySecondFactor(db, cfg, tf *models.TwoFactor, code string) (usedBackup bool, err error)` shared with Task 3: tries TOTP (updating `LastStep` with `WHERE last_step < ?`), then an unused backup code (marking `used_at` with `WHERE used_at IS NULL`); sends the "backup code used" notice when one is consumed.
  - `(*email.Sender).SendTwoFactorNotice(to string, event string) error`, events `enabled`, `disabled`, `backup_used`, `disabled_by_email`.

- [ ] **Step 1: Failing tests** (`twofactor_settings_test.go`, helpers from `devices_test.go`; email codes are seeded by inserting an `AuthCode` whose hash is `hashCode` of a known code, or by reading the code through a test hook — builder's call):
  - `TestTwoFactor_SetupConfirmEnables`: setup returns an `otpauth://totp/Shetu:` URL; confirm with a valid code → 10 backup codes; status `enabled: true, backup_codes_left: 10`.
  - `TestTwoFactor_ConfirmWrongCodeKeepsOff`.
  - `TestTwoFactor_UnverifiedEmailNeedsEmailCode`: unverified account → setup `email_code_sent: true`; confirm without `email_code` → 400; with it → enabled and `email_verified: true`.
  - `TestTwoFactor_UnavailableWithoutKey`: nil key → setup 503 `TWO_FACTOR_UNAVAILABLE`; status `available: false`.
  - `TestTwoFactor_DisableNeedsCode`: wrong code → 401, still on; backup code → 204, off.
  - `TestTwoFactor_RegenerateReplacesCodes`: old backup codes stop working.
  - `TestTwoFactor_DoesNotSignOutOtherDevices`: a second device's access token still works after enabling.
  - Purge test: two-factor rows deleted.
- [ ] **Step 2:** `go test ./internal/auth -run TestTwoFactor_ && go test ./internal/purge` → FAIL.
- [ ] **Step 3:** implement; register routes; add the three tables to purge step 4.
- [ ] **Step 4:** → PASS; `go test ./...` ok.
- [ ] **Step 5:** commit `feat(two-factor): turn on, turn off and regenerate backup codes`.

### Task 3: Server — challenge on login and OAuth, and `POST /auth/two-factor`

**Files:**
- Create: `internal/auth/twofactor_signin.go`, `internal/auth/twofactor_signin_test.go`
- Modify: `internal/auth/handlers.go` (login), `internal/auth/oauth.go` (callback success, exchange), `cmd/shetu-server/main.go`

**Interfaces:**
- Consumes: Tasks 1–2 (`verifySecondFactor`).
- Produces:
  - `twoFactorOn(db, userID) (*models.TwoFactor, bool)` (enabled rows only).
  - `newChallenge(db, userID, deviceID, path string, ttl time.Duration) (token string, err error)`.
  - `twoFactorRequired(c, token string)`: writes the 401 `TWO_FACTOR_REQUIRED` error with `challenge`.
  - `issueSignIn(c, db, cfg, user models.User, deviceID string)`: the extracted tail of `HandleLogin` (last_login_at, `recordDevice(..., true)`, refresh + access token, keyring, `Success`), used by login and by verify.
  - `POST /auth/two-factor {challenge, code, kind}` (rate limited): consumes one attempt atomically (`UPDATE … SET attempts = attempts + 1 WHERE token_hash = ? AND used_at IS NULL AND attempts < 5 AND expires_at > now`, 0 rows → `TWO_FACTOR_EXPIRED`); re-checks two-factor is still on (else `TWO_FACTOR_EXPIRED`); `kind: email` on non-recovery paths → `TWO_FACTOR_INVALID`; missing key → `TWO_FACTOR_UNAVAILABLE`; on a valid code marks `used_at` (`WHERE used_at IS NULL`, 0 rows → `TWO_FACTOR_EXPIRED`) and, for `login`/`oauth`, calls `issueSignIn` with the challenge's device id. Recovery handling is Task 4.
  - OAuth callback for an existing two-factor user: `oauthTargetURL(&state, cfg, "two_factor", {challenge, user_id})`; exchange answers `twoFactorRequired`.
- [ ] **Step 1: Failing tests:**
  - `TestTwoFactor_LoginReturnsChallengeOnly`: 401 `TWO_FACTOR_REQUIRED`, body has `challenge`, no `access_token`/`keyring`, no device row, no refresh token row.
  - `TestTwoFactor_VerifyIssuesSignIn`: valid code → same fields as a plain login; device recorded.
  - `TestTwoFactor_ChallengeLimits`: 5 wrong codes then a right one → `TWO_FACTOR_EXPIRED`; expired challenge → `TWO_FACTOR_EXPIRED`; reused challenge → `TWO_FACTOR_EXPIRED`.
  - `TestTwoFactor_ChallengeSingleUseUnderRace`: two concurrent verifies with the same valid code (one TOTP, one backup) → exactly one 200.
  - `TestTwoFactor_EmailKindRefusedOnLogin`.
  - `TestTwoFactor_DisabledMidChallengeExpires`.
  - `TestTwoFactor_MissingKeyFailsClosed`: enabled account, key removed → login still returns the challenge, verify → 503 `TWO_FACTOR_UNAVAILABLE`, no tokens.
  - `TestTwoFactor_OAuthCallbackRedirectsToCode`: redirect has `dest=two_factor` and `challenge`, no `access_token`. (Follow `oauth_test.go`'s callback setup.)
  - Existing login/OAuth tests stay green (accounts without two-factor unchanged).
- [ ] **Step 2:** `go test ./internal/auth -run TestTwoFactor_` → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `go test ./...` ok.
- [ ] **Step 5:** commit `feat(two-factor): ask for the code on password and OAuth sign-in`.

### Task 4: Server — recovery: challenge, email fallback, proof

**Files:**
- Modify: `internal/auth/handlers.go` (`HandleRecoveryPrefetch`, `HandleRecovery`, `recoveryRequest`), `internal/auth/twofactor_signin.go`, `cmd/shetu-server/main.go`
- Test: `internal/auth/twofactor_recovery_test.go`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `recoveryPrefetchData(db, user) (gin.H, error)`: the extracted success body of the prefetch.
  - Prefetch for a two-factor account → `twoFactorRequired` with a `recovery` challenge (15 min, empty device id).
  - `POST /auth/two-factor/email {challenge}` (rate limited): recovery challenges only (else `TWO_FACTOR_INVALID`), sends a `two_factor_recovery` code with `SendOtp`, 204. Works without `TWO_FACTOR_KEY`.
  - Verify on a `recovery` challenge: `kind: totp|backup` via `verifySecondFactor`; `kind: email` checks the `two_factor_recovery` auth code (attempts, TTL). Success → `recoveryPrefetchData` + `two_factor_proof` (a `recovery_proof` row, 10 min, `DisableTwoFactor = kind == "email"`).
  - `recoveryRequest.TwoFactorProof string json:"two_factor_proof"`: required (consumed atomically) when two-factor is on; a missing, used or expired proof → 401 `TWO_FACTOR_EXPIRED` and nothing changes. On success with `DisableTwoFactor` → delete two-factor rows and send `disabled_by_email`, in the same transaction as the password reset.
- [ ] **Step 1: Failing tests:**
  - `TestTwoFactor_PrefetchReturnsChallengeOnly`: no `dek_wrapped_by_recovery` in the body.
  - `TestTwoFactor_RecoveryWithAuthenticator`: verify → prefetch fields + proof; recovery with proof → 204, two-factor still on.
  - `TestTwoFactor_RecoveryNeedsProof`: recovery without/with a used proof → 401, password unchanged.
  - `TestTwoFactor_RecoveryEmailFallbackTurnsOff`: email code → verify kind email → recovery → 204, two-factor off.
  - `TestTwoFactor_EmailFallbackWorksWithoutKey`.
  - `TestTwoFactor_LoginAfterRecoveryInSameStepIsReused`: a TOTP code accepted in recovery, reused at login in the same step → `TWO_FACTOR_CODE_REUSED`.
  - Existing recovery tests stay green.
- [ ] **Step 2:** `go test ./internal/auth -run TestTwoFactor_` → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `go test ./...` ok; `gofmt -l internal` empty; `go vet ./...` clean.
- [ ] **Step 5:** commit `feat(two-factor): recovery asks for the code, with an email fallback that turns it off`.

### Task 5: Client — API

**Files:**
- Create: `src/lib/api/twoFactor.ts`, `src/lib/api/twoFactor.test.ts`
- Modify: `src/lib/api/auth.ts` (`ApiError.challenge?: string`; `recovery` params gain `two_factor_proof?: string`), `src/lib/oauth/oauth.ts` (+ test)

**Interfaces:**
- Produces:
  - `interface TwoFactorStatus { enabled: boolean; available: boolean; backup_codes_left: number; email_verified: boolean }`.
  - `type SecondFactorKind = "totp" | "backup" | "email"`.
  - `twoFactorApi.{status(): Promise<TwoFactorStatus>; startSetup(): Promise<{ otpauth_url: string; secret: string; email_code_sent: boolean }>; confirm(code: string, emailCode?: string): Promise<{ backup_codes: string[] }>; disable(code: string): Promise<void>; regenerateBackupCodes(code: string): Promise<{ backup_codes: string[] }>; verify<T>(challenge: string, code: string, kind: SecondFactorKind): Promise<T>; sendEmailCode(challenge: string): Promise<void>}` through the same `apiFetch` (export it from `auth.ts` or add a thin exported wrapper; builder's call). `verify` and `sendEmailCode` are unauthenticated like login.
  - `isTwoFactorRequired(err: unknown): err is AuthApiError` (code `TWO_FACTOR_REQUIRED` with a `challenge`).
  - `OAuthDest` gains `"two_factor"`; `OAuthResult.challenge?: string`; parse `dest=two_factor` with `challenge` and `user_id` (missing → `dest: "error"`).
- [ ] **Step 1: Failing tests:** each method hits the right method/path/body (mock `httpRequest` as `devices.test.ts` does); `isTwoFactorRequired` true only with code + challenge; oauth parse of `dest=two_factor`.
- [ ] **Step 2:** `npx vitest run src/lib/api/twoFactor.test.ts src/lib/oauth` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** commit `feat(two-factor): client API`.

### Task 6: Client — sign-in pauses for the code

**Files:**
- Create: `src/components/auth/forms/TwoFactorForm.tsx` (+ test), `src/stores/auth/authStore.twoFactor.test.ts`
- Modify: `src/stores/auth/authStore.ts`, `src/pages/auth/LoginPage.tsx`, `src/pages/auth/RecoveryPage.tsx` (+ their tests)

**Interfaces:**
- Consumes: Task 5.
- Produces (store):
  - `pendingTwoFactor: { path: "login" | "oauth" | "recovery"; challenge: string } | null`.
  - `submitTwoFactor(code: string, kind: SecondFactorKind): Promise<void>`: calls `twoFactorApi.verify` and resolves the waiting flow with the response; on error rethrows and keeps the screen (except `TWO_FACTOR_EXPIRED`, which rejects the waiting flow with that message and clears `pendingTwoFactor`).
  - `sendTwoFactorEmail(): Promise<void>` (recovery only).
  - `cancelTwoFactor(): void`: rejects the waiting flow with `SessionLost`-style cancellation, clears `pendingTwoFactor`, `isLoading: false`.
  - Module helper `awaitSecondFactor<T>(path, challenge): Promise<T>`: sets `pendingTwoFactor` and `isLoading: false`, returns a promise settled by submit/cancel; on resolve sets `isLoading: true` and clears `pendingTwoFactor`. Only one waiter at a time; a new one cancels the old.
  - Wiring (no other change to the flows):
    - `login`: `authApi.login(...)` wrapped so a `TWO_FACTOR_REQUIRED` error becomes `await awaitSecondFactor<LoginResponse>("login", challenge)`; the rest of `login` continues with that response.
    - `oauthStartFlow`: `result.dest === "two_factor"` → `awaitSecondFactor<LoginResponse>("oauth", result.challenge)`, then continue as the existing-user path with its tokens and user.
    - `recovery`: `recoveryPrefetch` wrapped the same way with path `recovery`; the response's `two_factor_proof` is passed to `authApi.recovery`.
    - The existing owner checks still apply after the wait (a sign-out during the code screen stops the flow).
- `TwoFactorForm` (props: `path`): title "Two-factor code"; field "6-digit code" (`inputMode="numeric"`, autofocus); toggle "Use a backup code" / "Use your authenticator"; on `recovery` also "Lost your authenticator? Email me a code" → `sendTwoFactorEmail`, then the field accepts the emailed code (kind `email`) with a note "We sent a code to your email."; Cancel → `cancelTwoFactor`; errors shown in the form's `Alert`.
- `LoginPage` and `RecoveryPage` render `TwoFactorForm` instead of their form while `pendingTwoFactor` matches their path(s).
- [ ] **Step 1: Failing tests** (`authStore.twoFactor.test.ts`, mocks as in `authStore.devices.test.ts`):
  - "login waits for the code and finishes with the verified response": `login` rejects with TWO_FACTOR_REQUIRED → `pendingTwoFactor.path === "login"`, `isLoading` false; `submitTwoFactor("123456","totp")` → `twoFactorApi.verify` called with the challenge; login resolves and `isAuthenticated` true.
  - "a wrong code keeps the screen": verify rejects TWO_FACTOR_INVALID → `submitTwoFactor` rejects, `pendingTwoFactor` unchanged.
  - "an expired challenge ends the sign-in": login rejects "Start signing in again.", `pendingTwoFactor` null.
  - "cancel returns to the form": login rejects, `isLoading` false, a late verify result is ignored.
  - "OAuth waits for the code" (dest two_factor).
  - "recovery passes the proof": `authApi.recovery` gets `two_factor_proof`.
  - "sign-out during the code screen stops the sign-in".
  - `TwoFactorForm` tests: backup toggle sends kind `backup`; email link only on recovery; Cancel calls `cancelTwoFactor`.
  - LoginPage/RecoveryPage show the form when pending.
- [ ] **Step 2:** `npx vitest run src/stores/auth src/components/auth src/pages/auth` → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; full `npx vitest run`; `npx tsc --noEmit`; biome on changed files.
- [ ] **Step 5:** commit `feat(two-factor): sign-in and recovery ask for the code`.

### Task 7: Client — Settings → Security → Two-factor

**Files:**
- Create: `src/components/settings/tabs/TwoFactorSettings.tsx` (+ test)
- Modify: `src/components/settings/tabs/SecurityTab.tsx`, `package.json` (`qrcode`, `@types/qrcode`, exact versions)

**Interfaces:**
- Consumes: Task 5 `twoFactorApi`.
- Behaviour:
  - Loads `status()`; `available: false` → "Two-factor isn't available on this server." and no button.
  - Off: "Turn on" → `startSetup()` → QR (`QRCode.toDataURL(otpauth_url)` as `<img alt="Two-factor QR code">`), secret text with Copy, "6-digit code" field, plus "Code from your email" field when `email_code_sent` → `confirm(code, emailCode)` → backup codes list with Copy and "Save to file" (Tauri save dialog, as `ExportModal` does) → "I saved these backup codes" tick enables "Done".
  - On: "On", "N backup codes left"; "New backup codes" and "Turn off", each asking for a code (TOTP or backup) in a `ConfirmDialog`-style form; new codes shown the same way as at setup.
  - Wired into `SecurityTab` only when `serverAuthenticated` (as `DevicesSettings`).
- [ ] **Step 1: Failing tests:** unavailable message; setup shows QR and secret; email field only when `email_code_sent`; Done disabled until the tick; Turn off asks for a code and calls `disable`; regenerate shows the new codes.
- [ ] **Step 2:** `npx vitest run src/components/settings/tabs/TwoFactorSettings.test.tsx` → FAIL.
- [ ] **Step 3:** `npm i qrcode @types/qrcode` (pin exact), implement.
- [ ] **Step 4:** → PASS; full `npx vitest run`; `npx tsc --noEmit`; biome on changed files; `cd src-tauri && cargo test --lib` unchanged.
- [ ] **Step 5:** commit `feat(two-factor): Settings section to turn it on and off`.
