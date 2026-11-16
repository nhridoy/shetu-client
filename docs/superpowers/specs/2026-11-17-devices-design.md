# Devices and revoke — design

Date: 2026-11-17 · Size: project (server + client) · Status: draft for approval

## Intent

See every device signed in to your account and sign one out remotely, for example a lost
laptop. A revoked device loses server access within seconds and erases its local vault the next
time it is online. This is the second project of the accounts & security phase.

Today the server keeps one refresh token per sign-in, tagged with the client's device id. It
stores no device name (`refresh_tokens.user_agent` is always empty) and has no list or revoke API.
A password change revokes other devices' refresh tokens, but those devices keep working offline
with their local copy.

## Decided (by the user)

- **Revoke** = cut access plus wipe on next contact.
  - The device can't call the API again within seconds.
  - The next time it is online, Shetu erases its local vault copy, keys, saved password and
    tokens, then shows sign-in with a notice. Offline it keeps working until it connects.
- **Names:** the OS computer name, sent by the client and renamable in the list. Each entry shows
  name · OS · app version · signed in · last active, with "This device" marked.
- **Bulk:** "Sign out all other devices" revokes and wipes every device except this one.
- **Approach:** a new `devices` table on the server.

## Goals / non-goals

- **Goals:** a list, revoke one, revoke all others, rename; revocation enforced on every request;
  wipe on next contact.
- **Non-goals:**
  - push notification to a revoked device (it learns on its next request or refresh);
  - location or IP history;
  - per-device permissions;
  - changing what a password change does (it still only revokes refresh tokens, no wipe);
  - security event log (a later project).
- **Anti-goals:**
  - never wipe a device because of doubt (offline, a server error, or a different account);
  - never let a request authenticated by a revoked device succeed after the revoke is committed.

## Approaches

1. **New `devices` table (chosen).**
2. Reuse `refresh_tokens` rows. Rejected: rotation creates a row per refresh, so metadata would be
   copied around and revoked state spread over many rows.

## Design

### Server (Go, gin + GORM AutoMigrate)

- **Model `Device`:**
  - `ID uint` pk;
  - `UserID uuid` (indexed, cascade delete);
  - `DeviceID string` (unique together with `UserID`);
  - `Name string`, `Platform string`, `AppVersion string`;
  - `CreatedAt`, `LastSeenAt time`;
  - `RevokedAt *time`.
- **Upsert on token issue.** Login, register, OAuth exchange/setup, recovery and refresh upsert the
  row for `(user, device_id)`:
  - set `LastSeenAt = now`;
  - a fresh sign-in (login, register, OAuth, recovery) clears `RevokedAt`, because the person
    has the credentials again;
  - refresh does **not** clear `RevokedAt`; it refuses a revoked device.
  - When `device_id` is empty (older clients), nothing is recorded.
- **Enforcement.**
  - **Middleware:** `JWTMiddleware`, after validating the token, rejects with
    `401 DEVICE_REVOKED` when the claims carry a device id whose row has `RevokedAt` set.
    One indexed lookup per request; an empty device id skips the check.
  - **Refresh:** a revoked device's refresh returns `401` (its tokens are revoked too).
- **Endpoints** (protected):
  - `GET /me/devices` returns active devices (not revoked, with at least one live refresh token):
    `[{device_id, name, platform, app_version, created_at, last_seen_at, current}]`, newest
    activity first.
  - `PUT /me/devices/current` with body `{name, platform, app_version}` sets this device's
    metadata (each field trimmed, max 100 chars). The client calls it after sign-in and on each
    app start while signed in.
  - `PATCH /me/devices/:device_id` with body `{name}` renames (trimmed, 1–100 chars).
  - `DELETE /me/devices/:device_id` revokes one device: sets `RevokedAt` and revokes its refresh
    tokens, in one transaction. The current device is refused (`400`; use Sign out).
  - `POST /me/devices/revoke-others` revokes every other device of the user.
- **Status for wipe.** The existing unauthenticated `POST /auth/account-status` accepts an
  optional `device_id`. When that device row is revoked, it adds `device_revoked: true`. An
  unknown device or an empty id adds nothing.
- **Tests:**
  - the upsert rules (sign-in clears, refresh doesn't);
  - middleware rejects a revoked device but allows an empty device id;
  - list excludes revoked devices and signed-out ones (no live refresh token);
  - revoke one / others is transactional, and refuses the current device;
  - rename validation;
  - account-status reports `device_revoked` only for that user's own device.

### Client

- **Device info.** The Rust command `device_info() -> { name, platform }` returns the computer
  name (`gethostname`, or the `hostname` crate if one is already in the tree) and `linux`,
  `macos` or `windows`. The app version comes from Tauri.
  - After a successful sign-in and on app start while server-authenticated, call
    `PUT /me/devices/current`. Best effort: errors are ignored.
- **Settings → Security → Devices** (new section):
  - the list as above, with "This device" marked;
  - per row, "Rename" (inline) and "Sign out" (confirm: "Sign out <name>? It loses access now and
    erases its Shetu data the next time it's online.");
  - a "Sign out all other devices" button with the same kind of confirm;
  - refresh on open; empty and error states.
- **Wipe on next contact.** The existing revoked-session path (`handleRevokedSession` →
  `accountStatus`) passes `device_id`.
  - When the response says `device_revoked`, it runs the same full reset the account-deleted path
    uses (`resetDevice(teardownSession)`). That erases the local vault, keys, saved password and
    tokens.
  - Then it shows the sign-in screen with a notice: "This device was signed out from another
    device. Its Shetu data was erased."
  - Offline, an error, or a different account → no wipe (as today).
  - A `401 DEVICE_REVOKED` from any request triggers the same path. `DEVICE_REVOKED` must reach
    `handleRevokedSession`, the same way a rejected refresh does.

### Decisions from the builder check

- **Wipe before a fresh sign-in.** A sign-in clears `RevokedAt`, so a revoked device that signs
  in again before learning it was revoked would keep its data. The client must call
  `accountStatus(user, device)` before any sign-in or server retry while it still holds a local
  account (offline access or a suspended server session). If the device is revoked, it wipes
  first. A device online with tokens learns sooner: its next request gets `DEVICE_REVOKED`, or its
  refresh is refused.
- **Revoke is a one-time sign-out, not a permanent block.** Device ids are made by the client (a
  reinstall gets a new one), so blocking an id stops nobody who has the password. The revoke
  confirm adds: "If it was lost or stolen, also change your password."
- **OAuth device ids.** The server records a device only for a UUID `device_id`. A missing id, the
  OAuth default `"default"`, or any other non-UUID records nothing. The client always sends its
  real device id on every sign-in path (check the OAuth exchange/setup calls).
- **Revoked-device signal.** The middleware's `401 DEVICE_REVOKED` sends the Rust HTTP client
  into a refresh. The refresh of a revoked device is refused with the existing plain `401`, and
  the existing session-revoked event follows, reaching `handleRevokedSession`. No new `http.rs`
  path is needed; keep the refresh refusal's current shape.
- **Missing names.** Until `PUT /me/devices/current` lands, a row has an empty name. The list
  shows "Unnamed device" plus the platform.
- **Existing sessions.** There is no backfill. A row is created on the next refresh or sign-in;
  access tokens last 15 minutes, so every active device appears within about 15 minutes of the
  server update. Until then such a device is not listed and can't be revoked.
- **`revoke-others` with no device id in the token** (older client) returns `400` ("Update Shetu
  to manage devices").

## Security notes

- The wipe needs the server to say this device is revoked; the client never wipes on its own
  guess.
- `account-status` stays unauthenticated, as today for deletion. It reveals only a device's
  revoked flag to someone who already knows both the user id and that device's id.
- The device name is stored in plain text on the server, like the email. The user can rename
  devices.

## Left to the builder

- Indexes, migration via AutoMigrate, response shapes beyond the fields above.
- Exactly where the client's "app start" call sits, as long as it runs after server auth.
- UI layout within the Security tab (reuse existing list, button and confirm patterns).

## Calls made without asking

- A device that signed out normally (no live refresh token) disappears from the list.
- The current device can't be revoked from the list; it uses Sign out.
- A fresh sign-in on a revoked device un-revokes it (the client checks and wipes first); refresh
  never does.
- The password-change behaviour is unchanged.
