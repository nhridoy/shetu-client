# App lock — design (short)

Date: 2026-11-16 · Size: small project (client only) · Status: draft for approval

## Intent

Shetu unlocks the vault once at start (master password, or the saved keychain password) and only
locks again on sign-out. Leaving it open leaves every key and secret usable. Add locking while
Shetu keeps running. First project of the accounts & security phase.

## Decided (by the user)

- **On lock:** connections keep running behind the lock screen (terminals, transfers, forwards).
  The vault keys are wiped from memory (existing `lock_session`), so nothing new can connect, sync
  or decrypt until unlock.
- **Triggers:** idle time; "Lock now"; system sleep / OS screen lock. Not minimise.
- **Unlock:** master password only. The saved keychain password is never used to skip an app lock.
- **Defaults:** idle lock Off until set (Off / 1 / 5 / 15 / 30 / 60 min). Lock on sleep/screen lock
  On by default. Both are per-device settings.
- **Detection:** native OS events, not a clock-gap heuristic.

## Approaches

1. **Native OS events (chosen).** Windows: session-lock (`WM_WTSSESSION_CHANGE` / `WTS_SESSION_LOCK`)
   and suspend (`WM_POWERBROADCAST` / `PBT_APMSUSPEND`) on a hidden message-only window registered
   with `WTSRegisterSessionNotification`. macOS: `NSWorkspaceWillSleepNotification` and the
   distributed `com.apple.screenIsLocked` notification. Linux: logind over D-Bus
   (`org.freedesktop.login1.Manager.PrepareForSleep(true)` and the current session's `Lock` signal).
   The crates are already in the tree via Tauri: `windows`, `objc2`/`objc2-app-kit`, `zbus`.
2. Clock-gap check. Rejected: it misses a screen lock without sleep.
3. Both. Rejected for now: logind covers mainstream Linux; can be added if users report gaps.

## Behaviour

- **Lock action** (one function used by every trigger): `lock_session` (keys wiped), `isUnlocked`
  false with `appLocked: true`. Sync stops while locked and restarts on unlock (the existing
  unlock/vault effect in Layout already does this). A **full-window opaque lock screen** covers
  everything: no terminal output, host names or titles visible. It holds the master-password field
  and a "Sign out" link. Focus goes to the password field. Keyboard input never reaches terminals
  while locked.
- **Unlock** reuses the existing `unlock(password)` path (re-derives and unwraps the keys).
  Afterwards it clears `appLocked`, restarts sync, and returns focus to where it was.
- **While locked:** forwards that drop retry as today and fail until unlock (keys are needed), then
  recover on the next retry. Background SSH sessions keep printing behind the cover. New
  connections, SFTP opens and decrypting actions are impossible because the UI is covered.
- **Idle:** keyboard, mouse or wheel activity anywhere in the Shetu window resets the timer.
  Terminal output does not count as activity. Only while unlocked and signed in.
- **Lock now:** a lock button in the sidebar footer and a rebindable shortcut `app.lock`
  (Ctrl+Shift+L / ⇧⌘L), shown in the command palette as "Lock Shetu".
- **OS events:** the Rust side emits a `system-lock` event; the frontend locks if the
  "Lock on sleep or screen lock" setting is on and the vault is unlocked.
- **Settings → Security** (new section): "Lock after idle" select, "Lock on sleep or screen lock"
  toggle. Stored per device in the existing settings store.
- Signed-out / not-yet-unlocked states are unchanged.

## Non-goals

PIN or biometric unlock; locking on minimise; disconnecting sessions on lock; a server-side session
lock.

## Tests

- **Lock action:** calls `lock_session`, sets locked state, shows the cover, hides content (no
  host/terminal text in the DOM while covered), and the keychain password isn't used to unlock.
- **Unlock:** wrong password stays locked with an error; right password unlocks and clears the
  cover.
- **Idle timer:** fires after the set minutes with no activity, and activity resets it; Off never
  fires; no firing while locked or signed out.
- **Shortcut/palette:** `app.lock` triggers the lock; the registry has it with the default bindings.
- **OS events:** the frontend `system-lock` listener locks only when the setting is on. Rust: the
  Linux logind signal handling is unit-tested where possible (signal → event mapping). Windows and
  macOS are compile-gated and reviewed by reading.
- **Settings:** values persist and default to Off / On.

## Calls made without asking

- Shortcut Ctrl+Shift+L / ⇧⌘L; lock button in the sidebar footer.
- The cover offers "Sign out" (an escape hatch for a forgotten password).
- Terminal output doesn't count as activity; only user input does.
