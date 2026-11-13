# Delete account (with a 30-day grace period) — design

## Intent

The README promises a working "Delete all data" option, and the feature-gap audit (G02,
`docs/FEATURE_GAP_AUDIT.md` in the monorepo) removed a fake button with that label because the
words could mean three different things. The user decided the meaning: **delete my account and
all its data**, everywhere, the way a person expects from a security app — with a **30-day grace
period** so a mistake or a stolen session can be undone.

Success: a user can request deletion from Settings; every device is signed out and wiped; for 30
days signing in lets them keep the account exactly as it was; after 30 days nothing of theirs is
left on the server.

## Goals

- **Request deletion** from Settings → Security → "Delete account" (a danger area).
  - The dialog lists what will be deleted: vault, hosts, keys, snippets, port forwards, session
    history, and **each team the user owns with its member count**, labelled "deleted for
    everyone". It says: "You have 30 days to change your mind — sign in again and choose “Keep my account” to cancel."
  - Confirmation: the user types their **account password** and their **email**. The server
    verifies the password with the same proof the password-change endpoint uses
    (`computeLoginProof` client-side; `HandlePasswordChange` verifier check server-side).
- On request the server:
  - marks the account `deletion_scheduled_for = now + 30 days`;
  - revokes every refresh token (signs out all devices);
  - sends, when email is configured, one notice: "Your Shetu account will be deleted on <date>.
    Sign in to cancel." Email failure never blocks the request.
- **This device** then fully resets: the existing sign-out teardown (vault cache, saved vault
  password, tokens, in-memory keys, port forwards) **plus** app settings (`settings.json`,
  including keyboard shortcuts), log files and SSH known-hosts — like a fresh install.
- **Other devices**, on their next contact with the server, are told the account is scheduled for
  deletion and wipe their local copy with the same full reset. (Today a rejected session
  deliberately keeps local data — `suspendServerSession` — so this needs a distinct server answer.)
  Edits they haven't synced yet are lost; the request dialog says so (designer's call — keeping
  them would need sync to stay open during the grace period).
- **Devices offline past day 30** are still told to wipe: the server keeps a minimal record of the
  deleted account — only its random ID and the deletion date, no email, name or data (user's
  decision).
- **Teammates are warned**: members of a team the user owns see a banner in the app during the
  grace period: "This team's owner is deleting their account. The team and its shared vault will
  be deleted on <date>." (user's decision).
- **During the grace period** teams the user owns keep working for their members, and the user's
  memberships in others' teams stay, so cancelling restores everything exactly.
- **Signing in** during the grace period succeeds and shows: "Your account is scheduled for
  deletion on <date>." with **Keep my account** (cancels the deletion) and **Sign out**. Nothing
  cancels silently.
- **After 30 days** a daily server job deletes, with no markers left behind (user's decision):
  every row of the teams the user owns (shared vaults, records, members, invites, envelopes,
  rotations, team sync operations); then removes the user from other teams **through the normal
  member-removal path**, so those teams rotate the keys the user held (designer's call); then every
  row the user owns; then the user. It writes the minimal deleted-account record. Signing in with
  that email afterwards creates a brand-new account.
  Consequence the user accepted: teammates' devices keep their cached copy of a deleted team's
  shared vault until they sign out — the grace-period banner is their warning.
- **Website**: the privacy policy gets a line about account deletion and the 30-day window.

## Non-goals

- Ownership transfer for teams (owned teams are deleted with the account, after the warning).
- "Reset this device only" or "erase synced data but keep the account".
- Restoring an account after the 30 days, or exporting data before deletion.
- Admin tooling to delete other users.

## Anti-goals

- Any path where a stolen access token alone deletes an account (the password proof is required).
- A success message when the server didn't record the request (on failure, say what did and
  didn't happen; nothing local is wiped unless the server confirmed).
- Silent cancellation of a scheduled deletion.
- Leftover data after day 30 beyond the minimal deleted-account record (ID + date): owned teams,
  shared vaults, memberships, invites, envelopes, sync history, session history, port forwards,
  workspaces, presets, tokens, keys, login nonces.
- Other devices keeping a readable local copy after they learn of the deletion.

## Constraints

- Server: Go + gin + GORM (`/run/media/…/terra/server`, repo shetu-server). **Do not rely on
  cascades**: on SQLite foreign keys are off (`internal/database/database.go`), and many tables
  (session history and output, port forwards, workspaces, presets, sync changes/operations, vault
  key envelopes and rotations, team sync operations, login nonces keyed by email) have no cascade.
  The purge deletes every table explicitly, and a test asserts no row referencing the user remains.
  The existing team delete (`internal/teams/handlers.go`, `team.delete` in `internal/teams/sync.go`)
  only marks rows deleted; owned-team purge needs a hard delete. Leaving others' teams reuses
  `member.remove` (`internal/teams/sync.go`) so vaults become `rotation_required`.
- Server has no background jobs yet; the daily purge is the first. It must be idempotent and safe
  to run on several server instances (each deletion in its own transaction; `deletion_scheduled_for
  <= now` re-checked inside it).
- Email (`internal/email/sender.go`) only sends OTP today and is often disabled on self-hosted
  servers; the deletion notice is best-effort.
- Client: Tauri v2 + React 19 + zustand. Server rejections reach the app through the Rust HTTP
  layer (`src-tauri/src/http.rs`), which today only refreshes on 401, treats a 403 from refresh as
  a generic failure, and emits the session-revoked event without an error code; it must pass
  `ACCOUNT_DELETION_SCHEDULED` / `ACCOUNT_DELETED` through so the client can take a full-reset path
  distinct from `onSessionRevoked` → `suspendServerSession` (keep local data).
- Sign-in methods are password and OAuth (Google/GitHub); the email code only confirms a new
  account. Users without a password verifier are OAuth sign-ups who never finished setup and
  can't reach Settings, so no special UI is needed for them.
- Web: Astro site (repo shetu-web), privacy policy page.
- Three repos, three PRs; the server ships first (the client must handle an older server that
  lacks the endpoint: show "Your server doesn't support account deletion yet" and change nothing).
- Tests first (Go `go test`, vitest, cargo test where Rust changes). No AI attribution anywhere.

## Approaches considered

- **A. Immediate deletion after a password proof** — simplest, irreversible.
- **B. 30-day grace period (chosen by the user)** — forgiving of mistakes and stolen sessions;
  needs a scheduled purge and a "deletion scheduled" state on server and client. About double A.
- **C. Immediate, confirmed by a recent sign-in instead of the password** — easier for OAuth
  users but weaker against an open stolen session.

## Design

### Server (shetu-server)

1. `users.deletion_scheduled_for` (nullable timestamp), migrated with the existing GORM setup.
2. `POST /api/v1/me/deletion` (protected): body carries the password proof (same fields and
   verification as password change: prelogin nonce + proof against the stored verifier) and the
   typed email (must equal the account email, case-insensitive). Sets the date, revokes all refresh
   tokens, sends the notice. Returns the scheduled date. Idempotent while already scheduled
   (returns the existing date). Users without a verifier get a clear error (see Open questions).
3. `DELETE /api/v1/me/deletion` (protected): cancels — clears the date. Returns 204.
4. While `deletion_scheduled_for` is set, every protected endpoint **except** `GET /me` and
   `DELETE /me/deletion` answers `403` with code `ACCOUNT_DELETION_SCHEDULED` (and the date), and
   token refresh answers the same code — checked **before** the revoked-token check, so devices
   whose tokens were just revoked still get this code rather than a plain 401. `GET /me` includes
   `deletion_scheduled_for`. Sign-in (password, OAuth) still succeeds, so the user can reach the
   choice. After the purge, a refresh or request for a deleted account answers `ACCOUNT_DELETED`,
   found through the minimal `deleted_accounts` record (how the token maps to the account ID is the
   builder's call).
4b. Team sync reports, for each team whose owner is scheduled for deletion, that date
   (e.g. `owner_deletion_scheduled_for`), so members' apps can show the banner.
5. Daily purge job started from `cmd/shetu-server/main.go`: for each user with
   `deletion_scheduled_for <= now`, in one transaction — hard-delete owned teams and everything
   under them, remove the user from other teams via `member.remove`, delete every table's rows for
   the user, delete the user, insert `deleted_accounts(user_id, deleted_at)`. Logs counts, never
   emails, never logs the email address.
6. Email: `Sender.SendAccountDeletionNotice(to string, on time.Time) error`.

### Client (shetu-client)

1. **API**: `requestAccountDeletion(proof, email)`, `cancelAccountDeletion()`; `User` gains
   `deletion_scheduled_for?: string`.
2. **Full reset** `resetDevice()`: existing `teardownSession()` + clear `settings.json` (settings
   and shortcuts, then reset the in-memory stores to defaults) + delete log files + delete the
   known-hosts file (a Rust command for the files, since they live in the app data dir).
3. **Settings → Security → Delete account**: danger area with a button; dialog lists owned teams
   (from the team store) with member counts and the 30-day note; password + email fields; the
   button stays disabled until the email matches. On success: `resetDevice()` and land on the
   sign-in screen with a notice "Your account will be deleted on <date>. Sign in to cancel."
   On failure: show the error; nothing is wiped.
4. **Other devices**: an `ACCOUNT_DELETION_SCHEDULED` or `ACCOUNT_DELETED` answer (from any request
   or refresh, passed through `src-tauri/src/http.rs`) triggers `resetDevice()` and the sign-in
   notice — not `suspendServerSession`.
4b. **Team banner**: team vault views show the warning when team sync reports the owner's
   deletion date.
5. **Sign-in during grace**: if `/me` reports a date, show a blocking dialog with **Keep my
   account** (calls cancel, then continues normally) and **Sign out** (signs out, no wipe needed
   beyond normal sign-out).

### Website (shetu-web)

Privacy policy (`src/pages/privacy.astro`): **replace** the current "no self-service deletion"
text with: users can delete their account from Settings; deletion is final after 30 days; signing
in within those 30 days cancels it; teams the user owns are deleted with it; the server keeps only
the account's random ID and deletion date afterwards so offline devices can be told to wipe.

## Open questions for the builder (minor — builder's call, flagged)

- Exact wording/layout of the danger area and dialogs, within the existing Settings style.
- Whether the purge also prunes rows that cascade already (verify with a test, don't assume).
- How a late device's token maps to the `deleted_accounts` record (e.g. the JWT subject).
- Whether a hosted-service database backup policy needs a note in the privacy policy (out of this
  design's code; mention to the user if backups outlive 30 days).
