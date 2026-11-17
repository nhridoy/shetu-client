# Two-factor sign-in — design

Date: 2026-11-17 · Size: project (server + client) · Status: draft for approval

## Intent

Optional second step when signing in to a Shetu account: after the first factor (master
password, Google/GitHub, or the recovery code), Shetu asks for a 6-digit code from an
authenticator app, or a single-use backup code. Someone who learns the master password, takes
over the Google/GitHub account, or finds the recovery code still can't get into the account
without the second factor. Third project of the accounts & security phase ("MFA: TOTP + backup
codes" in the gap analysis).

Today the server issues tokens and returns the encrypted keyring as soon as the first factor
checks out, and the master password decrypts that keyring. The recovery prefetch hands the
recovery-wrapped key to anyone with the recovery code. So the check must sit before any token,
keyring or wrapped key leaves the server, not only before tokens.

## Decided (by the user)

- **Every sign-in asks** once two-factor is on: password login, Google/GitHub sign-in, and the
  recovery-code reset.
- **Lost phone and backup codes:** on the recovery-code reset only, "Lost your authenticator?"
  emails a code to the account address. Recovery code + that emailed code resets the password and
  turns two-factor off, and an email says so. Password and OAuth sign-in never offer the email
  code.
- **Recovery stays a reset.** As today, the recovery-code reset sets a new password and sends the
  person to the sign-in screen. With two-factor on, the reset asks for a code, and the sign-in
  that follows asks again (unless the email fallback turned two-factor off). Two codes for
  someone with their phone is accepted.
- **Behaviour** (played back and confirmed):
  - Turning on (Settings → Security → Two-factor): QR code plus the secret as text, confirm with
    a code, then 10 single-use backup codes (Copy, Save to file) and a required "I saved these"
    tick before it is on.
  - Sign-in: a code screen with "Use a backup code"; wrong codes count against a limit.
  - Turning off, or generating new backup codes (which replace the old set): from a signed-in
    device, with a current authenticator or backup code.
  - Devices already signed in stay signed in; offline unlock and app lock are unchanged.
  - Emails when two-factor is turned on or off and when a backup code is used.
  - No "remember this device": a device stays signed in until sign-out, so a code is only asked
    at a fresh sign-in.
- **Approach:** two-step sign-in with a short-lived challenge (below).
- **Secret encryption:** a dedicated `TWO_FACTOR_KEY` server environment variable. Without it,
  two-factor can't be turned on on that server and Settings says so.

## Goals / non-goals

- **Goals:** TOTP setup with backup codes; the check on every sign-in path that issues tokens or
  key material; email fallback on the recovery path; turn off and regenerate backup codes;
  notice emails.
- **Non-goals:** passkeys/WebAuthn; SMS; "trust this device"; a team policy requiring two-factor
  (teams phase); a security event log (next project); asking for a code on password change or
  other actions of an already signed-in device.
- **Anti-goals:**
  - no token, keyring or recovery-wrapped key leaves the server for a two-factor account before
    the second factor checks out;
  - the email code must never be enough on its own, nor with only the password or an OAuth login;
  - nobody already signed in is signed out by turning two-factor on;
  - a server without `TWO_FACTOR_KEY` behaves exactly as today.

## Approaches

1. **Challenge token (chosen).** The first-factor endpoint returns `two_factor_required` and a
   challenge instead of its normal result; `POST /auth/two-factor` with the challenge and a code
   returns that normal result. One verification endpoint for every path.
2. **Resend the request with the code.** Rejected: login nonces and OAuth codes are single-use,
   so a missing or wrong code would mean redoing the whole flow, including the browser round
   trip for Google/GitHub.
3. **Limited session unlocked by the code.** Rejected: tokens would exist before the code, and
   every protected route would need a "half signed in" state.

## Design

### Server (Go, gin + GORM)

- **Model** (new table, or columns on `users`; builder's call): encrypted TOTP secret, enabled
  at, last accepted time step (replay guard), and backup code hashes with used-at. A pending
  secret during setup is stored separately until confirmed, so an abandoned setup never turns
  two-factor on.
- **Codes:** `pquerna/otp` TOTP, SHA-1, 6 digits, 30-second step, ±1 step for clock drift. A
  step at or before the last accepted one is rejected. Backup codes: 10 random codes, shown
  once, stored hashed, single use.
- **Secret encryption:** AES-256-GCM with a key from `TWO_FACTOR_KEY` (32 bytes, base64).
  Missing or invalid → the server starts normally and reports two-factor unavailable; setup
  endpoints refuse with a clear code. Accounts that already have two-factor on while the key is
  missing can't sign in (fail closed) and get a clear error.
- **Challenge:** created when the first factor succeeds for an account with two-factor on. It is
  random, stored hashed, single use, valid 5 minutes (recovery: 15), bound to the user, the device id and the
  path (`login`, `oauth`, `recovery`), and allows 5 code attempts before it is void. Recovery
  challenges last 15 minutes (the email code's lifetime) and have no device id, since recovery
  sends none. The challenge carries what is needed to finish its path; the first-factor endpoint
  commits nothing else.
- **Paths:**
  - **Response shape:** login and recovery prefetch answer `403` (not 401: the app's HTTP layer
    reads a 401 as an expired session) with code `TWO_FACTOR_REQUIRED`,
    the challenge in the error details, and a message an older client can show as is ("Enter
    your two-factor code. Update Shetu if you don't see a code field."). Older clients then fail
    closed with a readable error; no version detection.
  - `POST /auth/login`: valid proof + two-factor on → `TWO_FACTOR_REQUIRED`, no tokens, no
    keyring, no device recorded.
  - OAuth callback for an existing user: redirects with `dest=two_factor&challenge=…` instead of
    `dest=success` and tokens (an older client shows its "unknown destination" error).
    `POST /auth/oauth/exchange` follows the same rule if it can issue tokens to a two-factor
    account.
  - `POST /auth/recovery/prefetch`: two-factor on → challenge instead of the wrapped keys.
    Verifying a recovery challenge returns the prefetch material plus a single-use proof (valid
    10 minutes) that `POST /auth/recovery` then requires for a two-factor account. Recovery itself
    is unchanged otherwise: it resets the password, revokes refresh tokens, returns 204, and the
    client sends the person to sign in.
  - `POST /auth/two-factor {challenge, code, kind: totp|backup|email}`: on success returns
    exactly what the first-factor endpoint returns today: for login and OAuth, tokens, user and
    keyring, recording the device as a fresh sign-in; for recovery, the prefetch material and the
    proof. A TOTP code in the same 30-second step as the last accepted one is refused with a
    "wait for the next code" message (this happens when the sign-in follows a recovery quickly).
  - `POST /auth/two-factor/email {challenge}`: recovery challenges only; emails a 6-digit code
    (reusing the email-code table, its TTL and attempt limit). A successful `kind: email`
    verification marks two-factor for removal; it is removed when the recovery completes. The
    email path never needs the authenticator secret, so it works even when `TWO_FACTOR_KEY` is
    missing: recovery code + inbox is the way back if the key is lost for good.
- **Settings endpoints** (protected): status (`enabled`, backup codes left, server available);
  start setup (returns the `otpauth://` URI and the secret); confirm setup with a code (enables,
  returns backup codes); disable with a code; regenerate backup codes with a code.
- **Email must work before turning on.** The email fallback is the only way back without the
  phone, so an account whose email isn't verified must confirm it during setup: start setup also
  emails a 6-digit code (reusing the email-code table), and confirm setup needs it alongside the
  authenticator code. A successful confirm marks the email verified. Accounts already verified
  skip this step.
- **Emails:** two-factor turned on, turned off (including via the email fallback), backup code
  used. Best effort, never blocking.
- **Tests:** each path refuses to hand out tokens or key material without the second factor;
  challenge expiry, single use, attempt limit, device and path binding; TOTP drift window and
  replay; backup code single use; email code only on recovery challenges; email fallback turns
  two-factor off only when the recovery completes; missing key behaviour; disable and
  regenerate require a code.

### Client

- **Sign-in:** `login`, `oauthStartFlow` and the recovery flow handle `TWO_FACTOR_REQUIRED` (and
  OAuth `dest=two_factor`). A
  code screen replaces the form: 6-digit field, "Use a backup code" switch, and on the recovery
  path "Lost your authenticator? Email me a code". A successful verification continues exactly
  as the first factor would have. The app keeps whatever the first factor already derived in
  memory (e.g. the KEK from the password), so the password isn't asked again.
- **Recovery:** the recovery page asks for the code after the recovery code is checked, then
  carries on as today (new password, new recovery code shown, then the sign-in screen).
- **Settings → Security → Two-factor:** status; Turn on (QR drawn from the `otpauth://` URI with
  the `qrcode` package, secret shown as text with copy, confirm code, plus the emailed code when
  the email isn't verified yet, backup codes with Copy and
  Save to file, required "I saved these" tick); Turn off and New backup codes (each asks for a
  code); "unavailable on this server" when the server says so; backup codes left.
- **Errors:** wrong code, expired challenge ("Start signing in again"), too many attempts, and
  a server without two-factor support (older server: no change).
- **Tests:** each sign-in path stops at the code screen and resumes after it; the email option
  only on recovery; setup requires the tick; turn off and regenerate ask for a code.

## Security notes

- The server can read authenticator secrets (it has to, to check codes), encrypted at rest with a
  key outside the database.
- The recovery code alone no longer exposes the vault for a two-factor account. Recovery code +
  account email inbox is the deliberate escape hatch.
- Challenges and email codes are attempt-limited; the existing auth rate limiter covers the new
  endpoints.

## Left to the builder

- Table layout, migrations, exact response shapes beyond the fields above.
- How the client holds first-factor state while the code screen is open.
- Layout of the code screen and the Settings section, reusing existing forms, dialogs and copy
  buttons.

## Calls made without asking

- SHA-1, 6 digits, 30 seconds: what every authenticator app supports by default.
- 10 backup codes; 5 attempts per challenge; recovery proof valid 10 minutes.
- Fail closed when `TWO_FACTOR_KEY` disappears after accounts enabled two-factor, except the
  recovery email fallback, which doesn't need the key.
- An unverified email is confirmed with an emailed code during setup.
- Older clients get a readable `TWO_FACTOR_REQUIRED` error, no version detection.
- Recovery challenges last 15 minutes; login and OAuth challenges 5.
- Turning two-factor on doesn't sign out other devices.
