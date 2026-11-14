# Account-deletion hardening (issue #28) — short design

Follow-ups from the review of #27. Each is a narrow failure or load case; none blocks normal use.

## Decisions (user)

1. **Status-check backoff.** A suspended device with no saved refresh token asks `account-status`
   once per launch, then at most every 15 minutes while running (was: every 30-second sync retry).
   A rejected session (fresh `session-revoked` event) still asks immediately.
2. **Persisted sign-out marker.** If deleting the keychain refresh token fails at sign-out, persist a
   small marker (app data dir). At launch: retry the delete; while the marker exists, Rust refuses to
   refresh (same as the in-memory signed-out flag). The next successful sign-in clears it.
3. **Keychain write failure at sign-in.** Sign-in proceeds for this run; show one toast:
   "Couldn't save your sign-in. You'll need to sign in again next time."
4. **Keychain I/O under the token lock.** Won't fix: moving it out reopens the races fixed in #27;
   cost is a brief stall when the keychain is slow. Reply on the issue.
5. **Error mapping.** Map deletion-request errors by the server's error code first
   (`ACCOUNT_DELETION_SCHEDULED` → "Your account is already scheduled for deletion.",
   bad/expired nonce → "Something went wrong. Please try again."), HTTP status as fallback
   (404/403/400 copy unchanged).
6. **Log files after reset.** Truncate log files to zero length instead of deleting them, so the
   logger keeps writing to the same, now-empty file.

## Approaches considered

- Backoff: once-per-launch only (too slow for a long-running app), exponential (more code) —
  user chose launch + 15 min.
- Keychain write error: fail the sign-in (harsh), log only (silent) — user chose sign in + warn.

## Out of scope

Item 4 code change; any other auth refactor.

## Tests

Each fix test-first (vitest / cargo test). Full suites, tsc, biome and cargo test green.
