# Realtime sync — design

Date: 2026-11-17 · Size: project (server + client) · Status: draft for approval

## Intent

Today every open Shetu app asks the server "anything new?" every 30 seconds. A change made on one
device, or by a teammate, can take up to 30 seconds to show elsewhere, and a device signed out
remotely only finds out at its next request. Instead, each open app keeps one live connection to
the server, and the server says "something changed" (or "this device was signed out") the moment
it happens. The app then runs its normal sync. Gap analysis: "Sync: 30 s polling → push over
WebSocket (notify → pull)". This is the last project of the accounts & security phase.

## Decided (by the user)

- **Notify, then pull.** The live connection only carries short signals. Data still moves through
  the existing encrypted `POST /sync/push` and `/sync/pull`, which keep their retries, idempotency,
  conflict handling and team logic. Moving data itself onto the live connection was considered and
  rejected: it would rebuild sync and still need the old path as a fallback, to save about 0.1 s.
- **Signals:**
  - `changed`: something the app's sync would bring in changed: a vault the user can see (their
    own, or a team vault they're in), or anything team-side (team created, renamed or deleted;
    team vaults; invites; members, roles, leaving). The app syncs. `requestAll()` already runs
    personal and team sync, so team changes need no separate signal (my call, replacing a
    separate `teams_changed`).
  - `device_revoked`: sent only to the signed-out device. It erases its data at once (today's wipe
    path) and shows the sign-in notice.
  - `account_changed`: password changed, two-factor turned on or off, other devices signed out,
    a recovery reset, or account deletion scheduled or cancelled. The app re-checks its session
    at once (a forced token refresh).
    - A device whose session the change revoked shows "Sign in to sync" right away and keeps its
      local work, as today (my call). It is not sent to the sign-in screen.
    - A scheduled deletion shows the existing Keep / Sign out choice right away.
- **Polling:**
  - Sync on app open stays.
  - While the live connection is up, the 30-second check stops; a 5-minute safety sync remains.
  - When the connection is down or unavailable (offline, asleep, blocked network, older server),
    the app goes back to the 30-second check.
  - It reconnects with growing delays (1 s, 2 s, 4 s … up to 60 s) and syncs once on every
    reconnect to catch up.
- **"Live" in the sync status** while connected. It replaces only "Synced"; pending, error and
  "Sign in to sync" still show (my call).
- **While app-locked, the connection stays open.** A locked device that is signed out remotely
  (e.g. a stolen laptop) gets `device_revoked` and erases its data at once, even on the lock
  screen. Other signals wait: syncing only runs while unlocked, and the app syncs on unlock.
- **Transport: Server-Sent Events (SSE)**, not WebSocket. One HTTPS request the server keeps open
  and writes event lines into. Same behaviour and speed. Chosen because:
  - it needs no new library on either side;
  - it reuses the existing tokens, proxy setup and error handling;
  - it can share the app's existing HTTPS connection to the server;
  - it gets through more networks.
- **Mobile later:** SSE works while a future mobile app is on screen. In the background, phones
  need Apple/Google push notifications. The server sends every signal through one internal
  publisher, so a push-notification sender can be added later as a second delivery path.

## Goals / non-goals

- **Goals:** the three signals; the live connection with fallback and reconnect; polling changes;
  the Live indicator; signals for personal and team vaults.
- **Non-goals:**
  - data over the live connection;
  - presence or typing indicators (teams phase);
  - phone push notifications (mobile project);
  - delivery across several server copies (see Constraints);
  - signals to a web browser.
- **Anti-goals:**
  - the live connection never carries vault data, names or anything decryptable;
  - a signed-out or expired session never keeps listening;
  - an app that can't connect works exactly as today;
  - the server holds no per-connection state beyond memory, and a restart just makes apps
    reconnect;
  - no extra database work while nothing changes.

## Constraints

- **One process:** the Shetu server runs as one process today. Open connections are tracked in
  memory, so a change made through one copy of the server wouldn't reach apps connected to
  another copy until the 5-minute safety sync. Fanning out across copies (e.g. Postgres
  LISTEN/NOTIFY) is a later step; the README should say that live updates assume one server
  process.
- **Proxy buffering:** behind Caddy (the documented proxy), streamed responses are flushed as
  written. The server sets `Cache-Control: no-cache` and `X-Accel-Buffering: no` for other
  proxies.
- **Tokens live in Rust:** the app's sign-in tokens live in the Rust HTTP layer, so the live
  connection runs there too.

## Approaches

1. **SSE, notify → pull (chosen).** No new dependencies, and it reuses the existing request
   plumbing.
2. **WebSocket, notify → pull.** Same behaviour. It needs a WebSocket library on both sides and a
   separate connection, and some proxies refuse the upgrade. Two-way messaging isn't needed.
3. **Sync over the live connection.** Rejected (see Decided).

## Design

### Server (Go, gin)

- **Package `internal/live`, a hub:**
  - in-memory subscribers keyed by user id, each with its device id and a small buffered
    channel;
  - `Subscribe(userID, deviceID) (ch, cancel)`;
  - `Publish(userIDs []uuid.UUID, kind string, exceptDevice string)`;
  - `PublishDevice(userID, deviceID, kind)` for `device_revoked`.
  - Publishing never blocks: a full channel drops the signal for that subscriber, which then
    relies on the next signal or the safety sync.
  - One process-wide hub is created in `main.go` and passed to the handlers that publish.
- **Endpoint `GET /api/v1/live`** (protected by `JWTMiddleware`, so a revoked device is refused):
  - **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
    `X-Accel-Buffering: no`.
  - **First line:** `event: ready`.
  - **Signals:** one `event: <kind>` (with `data: {}`) per signal.
  - **Keep-alive:** a `: ping` comment every 25 seconds.
  - **Closing:**
    - it closes when the access token expires (from its `exp` claim), so an expired or signed-out
      session can't keep listening;
    - it closes right after sending `device_revoked`;
    - it closes when the client disconnects.
  - Limit (builder's call on the number, e.g. 10): open streams per user; the oldest is closed
    past the limit.
- **Who publishes what:**
  - **`changed`:** `HandlePush`, after a successful push that changed anything, publishes to every
    user who can see the vault (the owner for a personal vault, active members for a team vault),
    except the pushing device. Team key rotation and vault deletion publish the same way.
  - **`device_revoked`:** the device revoke handlers publish to the revoked device(s).
  - **`changed` from team writes:** every successful team write publishes `changed` to the team's
    current members and to anyone it affects (an invite's recipient, a removed member). That
    covers the batched `POST /teams/sync` handler (`internal/teams/sync.go`: team, vault, invite,
    member and rotation operations) and the REST handlers in `members.go`, `invites.go`,
    `vaults.go` and `rotation.go`.
  - **`account_changed`:**
    - password change → the user's other devices;
    - two-factor confirm and disable → all of the user's devices;
    - revoke-others → the remaining device;
    - recovery reset → all devices (their tokens are already revoked);
    - deletion scheduled or cancelled → all of the user's devices.
    - After scheduling a deletion, the hub also closes all the user's streams
      (`CloseUser(userID)`): `DeletionGate` only checks when a stream opens.
- **Tests:**
  - stream headers, `ready`, a published signal arrives, ping, close at token expiry;
  - `device_revoked` reaches only that device and closes it;
  - the pushing device doesn't get its own `changed`;
  - team members get `changed` for a team vault, non-members don't;
  - a full subscriber doesn't block a publisher;
  - a revoked device can't open the stream (middleware).

### Client — Rust

- **Live task:** a background task streams `GET /api/v1/live` through the existing HTTP layer, with
  the same base URL, token and refresh logic. The `reqwest` `stream` feature is enabled; that is
  not a new dependency.
- **Parsing:** SSE lines; each event is emitted to the webview as Tauri event `live://event` with
  `{kind}`. Connection state goes out as `live://status` (`connected` | `disconnected`).
- **Commands:**
  - `live_start()` is idempotent;
  - `live_stop()` runs on sign-out, lock wipe or teardown;
  - starting while signed out does nothing.
- **Reconnect:**
  - when the stream ends or errors: back off 1 s, 2 s, 4 s … 60 s; reset after a stream that
    stayed up for over a minute;
  - on `401`: the normal refresh-once path, then reconnect; a revoked session stops the task and
    fires today's session-revoked event;
  - on `404` (older server): stop, and retry every 10 minutes;
  - on `403`/`410` (deletion scheduled or account gone): stop until the session changes (next
    sign-in or the Keep choice); no backoff retries.
  - The stream uses its own request timeouts: no overall timeout (the shared client's 30 s would
    cut it), plus a read-idle timeout of about 60 s (over two missed pings), so a connection that
    died during sleep is noticed.
  - The planned close at token expiry reconnects quietly: no status flip and no sync.
- **Lifetime:** the stream follows the server session, not the unlock state. It runs while the app
  is server-authenticated (locked or not) and stops on sign-out, teardown or a revoked session.
  There is no stream while signed out or on a local-only account.

### Client — web

- **Auth store** owns `live_start` / `live_stop`: it starts the stream when the session reaches the
  server and stops it on sign-out and teardown.
- **Sync store** (`syncStore.start`, which runs only while unlocked):
  - listens for `live://status` and `live://event`;
  - on `connected`, syncs once and switches the timer to 5 minutes;
  - on `disconnected`, switches back to 30 seconds;
  - on `changed`, calls `requestAll()`, coalesced so a burst of signals runs at most one sync at a
    time plus one after it.
- **Auth store** (handles these even while locked):
  - `device_revoked` → `handleRevokedSession()`, today's wipe and notice path. It must work from
    the lock screen: the wipe clears the lock state and shows sign-in with the notice.
  - `account_changed` → forces a session check, refreshing the token now.
- **Sync status:** shows "Live" while connected; otherwise as today.
- **Tests:**
  - timer switching on connect/disconnect;
  - a sync on connect;
  - `changed` coalescing;
  - each signal's action, including `device_revoked` while locked;
  - the Live label;
  - the Rust SSE parser (events, comments, partial chunks) and the backoff schedule.

## Security notes

- The stream is authenticated like any API call and closes at token expiry, so a revoked or
  signed-out session stops receiving signals within its token's lifetime at most, and at once
  for `device_revoked`.
- Signals carry no data: a kind and nothing else, so even a logged or proxied stream reveals only
  that something happened.
- Per-user stream limit, and the server holds only memory per connection.

## Left to the builder

- Hub data structure, channel size, stream limit, ping interval (about 25 s), exact Tauri wiring,
  where the Live label sits in `SyncStatus.tsx`.

## Calls made without asking

- Ping every 25 s; close at token expiry; reconnect backoff 1–60 s; after a 404, retry every
  10 minutes; after a 403/410, stop until the session changes.
- Team changes travel as `changed` (no separate team signal).
- `account_changed` on a revoked session keeps today's "Sign in to sync" with local work kept.
- The Live label replaces only "Synced".
- The pushing device doesn't get its own `changed`.
- Dropped signals (full buffer) are accepted; the 5-minute safety sync covers them.
- README note: live updates assume one server process.
