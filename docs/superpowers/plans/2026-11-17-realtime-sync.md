# Realtime Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Shetu apps learn about changes and account events within about a second through a Server-Sent Events stream, and stop polling every 30 s while it is up.

**Architecture:** The server keeps an in-memory hub of open `GET /api/v1/live` streams per user and publishes `changed`, `device_revoked` and `account_changed` from the places those happen. The app's Rust layer holds the stream (tokens live there), parses SSE and emits Tauri events. The web layer turns them into syncs, wipes and session checks, and switches the poll between 5 min (live) and 30 s (not live).

**Tech Stack:** Go gin (no new deps), sqlite tests; Tauri v2 Rust (`reqwest` `stream` feature, already a dependency), React 19 + zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-realtime-sync-design.md`

**Repos:** Tasks 1–2 in the server repo `/run/media/nahidujjaman-hridoy/5ECC6955CC69288B/terra/server`, branch `feat/realtime-sync` from `origin/main`; tests `go test ./...`. Tasks 3–4 in this client repo on `feat/realtime-sync`; tests `cd src-tauri && cargo test --lib`, `npx vitest run`, `npx tsc --noEmit`, `npx biome check <changed files>` (never whole folders), `cargo fmt --check` on touched Rust files.

## Global Constraints

- Signals (exact): `changed`, `device_revoked`, `account_changed`. Wire format: `event: <kind>\ndata: {}\n\n`; first `event: ready\ndata: {}\n\n`; keep-alive comment `: ping\n\n` every 25 s.
- Stream headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- The stream closes at the access token's `exp`, right after `device_revoked`, on client disconnect, and for every stream of a user when deletion is scheduled. Max 10 open streams per user (oldest closed).
- Signals never carry data beyond the kind.
- Publishing never blocks (buffered channel; full → drop for that subscriber).
- The pushing device doesn't get its own `changed`.
- Client backoff 1, 2, 4, 8, 16, 32, 60 s (cap 60), reset after a stream that stayed up over 60 s. On 404: retry every 10 min. On 403/410: stop until `live_start` is called again. Read-idle timeout 60 s. No overall request timeout on the stream.
- Poll: 5 min while live, 30 s otherwise; one sync on every `connected`; `changed` syncs are coalesced (one running + at most one queued).
- Tauri events: `live://event` payload `{ kind: string }`, `live://status` payload `"connected" | "disconnected"`. Commands `live_start()`, `live_stop()`.
- Sync status label (exact): "Live", replacing only the "Synced" state.
- `device_revoked` must work while app-locked; other signals act only while unlocked (sync runs only then; a sync happens on unlock).
- README: "Live updates assume one server process; behind several copies, changes reach apps on other copies within 5 minutes."
- No Claude/AI attribution in commits.

## Review Focus

1. A burst of 50 `changed` signals → at most 2 syncs run (one in flight + one queued). (Task 4 test "changed bursts coalesce".)
2. SSE bytes split mid-line, several events in one chunk, `\r\n` line endings, and comment lines → each event parsed exactly once. (Task 3 test `sse_parser_handles_chunking`.)
3. A connection that goes silent (laptop slept) → reconnect after the 60 s read-idle timeout, not never. (Task 3 test `live_idle_stream_reconnects`, with a 100 ms idle timeout injected.)
4. `live_stop()` during a backoff wait → no reconnect afterwards. (Task 3 test `live_stop_cancels_backoff`.)
5. `device_revoked` while app-locked → the wipe runs and the lock screen gives way to sign-in with the notice. (Task 4 test "device_revoked wipes while locked".)

---

### Task 1: Server — live hub and `GET /api/v1/live`

**Files:**
- Create: `internal/live/hub.go`, `internal/live/hub_test.go`, `internal/live/handler.go`, `internal/live/handler_test.go`
- Modify: `cmd/shetu-server/main.go`, `README.md`

**Interfaces:**
- Produces:
  - `live.Default *Hub` (process-wide; tests swap it with `live.Default = live.NewHub()` and restore).
  - `NewHub() *Hub`.
  - `(*Hub).Subscribe(userID uuid.UUID, deviceID string) (<-chan string, func())`.
  - `(*Hub).Publish(userIDs []uuid.UUID, kind string, exceptDevice string)`: every stream of those users except `exceptDevice`.
  - `(*Hub).PublishDevice(userID uuid.UUID, deviceID, kind string)`: also closes those streams after delivery.
  - `(*Hub).CloseUser(userID uuid.UUID)`.
  - Constants `KindChanged = "changed"`, `KindDeviceRevoked = "device_revoked"`, `KindAccountChanged = "account_changed"`.
  - `HandleLive(cfg *config.Config) gin.HandlerFunc` on `GET /api/v1/live` behind the protected group (JWT + DeletionGate). It reads the token `exp` from the claims (expose what the middleware already parses via `c.Set`, e.g. `token_exp`).
  - Var `pingEvery = 25 * time.Second` (tests shorten).
- [ ] **Step 1: Failing tests:**
  - `TestHub_PublishReachesUserExceptDevice`;
  - `TestHub_PublishDeviceClosesThatStream`;
  - `TestHub_FullSubscriberNeverBlocks` (publish 1000 without reading → returns promptly);
  - `TestHub_CloseUser`;
  - `TestHub_LimitClosesOldest` (11th subscribe closes the first);
  - `TestLive_StreamHeadersReadyAndSignal` (real `httptest.Server`: headers, first `event: ready`, a published `changed` arrives as `event: changed`);
  - `TestLive_Ping` (with `pingEvery` 20 ms → `: ping`);
  - `TestLive_ClosesAtTokenExpiry` (token expiring in 1 s → stream ends);
  - `TestLive_RevokedDeviceRefused` (middleware 401 `DEVICE_REVOKED`).
- [ ] **Step 2:** `go test ./internal/live/...` → FAIL (undefined).
- [ ] **Step 3:** implement; register the route in `main.go`; add the README line.
- [ ] **Step 4:** → PASS; `go test ./...`, `go vet ./...`, `gofmt -l` clean.
- [ ] **Step 5:** commit `feat(live): live event stream`.

### Task 2: Server — publish signals

**Files:**
- Modify: `internal/sync/handlers.go` (push), `internal/teams/*.go` (writes), `internal/auth/devices.go`, `internal/auth/handlers.go` (password change, recovery), `internal/auth/twofactor_settings.go` (confirm, disable), `internal/auth/deletion.go` (schedule, cancel)
- Test: `internal/sync/handlers_live_test.go`, `internal/teams/live_test.go`, `internal/auth/live_signals_test.go`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `sync`: after a successful push that applied at least one operation, publish `changed` to the audience of each affected vault, except the pushing device (`c.GetString("device_id")`): the owner for a personal vault, active `team_members` for a team vault.
  - `teams`: `notifyTeam(db *gorm.DB, teamID uuid.UUID, extra ...uuid.UUID)` publishes `changed` to the team's active members plus `extra` (invite recipient, removed or leaving member). It's called after every successful write in the REST handlers (members, invites, vaults, rotation, team create/rename/delete) and once per affected team after a successful `/teams/sync` batch.
  - `auth`:
    - `PublishDevice(device_revoked)` for each device a revoke actually changed;
    - `account_changed` → the other devices on password change and revoke-others;
    - `account_changed` → all devices on two-factor confirm/disable, recovery, and deletion schedule/cancel;
    - `CloseUser` after deletion is scheduled, once its `account_changed` has been published.
- [ ] **Step 1: Failing tests** (subscribe to `live.Default` directly; no HTTP stream needed):
  - `TestLive_PushNotifiesOtherDevicesNotPusher`;
  - `TestLive_TeamVaultPushNotifiesMembersOnly`;
  - `TestLive_TeamWritesNotifyMembers` (rename via REST and via `/teams/sync`; invite notifies the recipient; remove notifies the removed member);
  - `TestLive_RevokeSendsDeviceRevokedToThatDevice`;
  - `TestLive_PasswordChangeNotifiesOtherDevices`;
  - `TestLive_TwoFactorChangeNotifiesAllDevices`;
  - `TestLive_DeletionScheduledNotifiesAndCloses`;
  - `TestLive_NoSignalOnFailedWrite` (a refused push publishes nothing).
- [ ] **Step 2:** `go test ./... -run TestLive_` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `go test ./...` ok; vet/gofmt clean.
- [ ] **Step 5:** commit `feat(live): publish changes and account signals`.

### Task 3: Client — Rust live stream

**Files:**
- Create: `src-tauri/src/live.rs` (+ tests inside)
- Modify: `src-tauri/Cargo.toml` (`reqwest` features add `"stream"`), `src-tauri/src/http.rs`, `src-tauri/src/lib.rs` (module, managed state, commands)

**Interfaces:**
- Produces:
  - `HttpClient::open_stream(&self, path: &str) -> Result<reqwest::Response, HttpErrorKind>`: the same auth, 401 → refresh-once → retry and `SessionExpired` rules as `request`, on a client with no overall timeout. It returns the response for status ≥ 400 too, so the caller sees 403/404/410.
  - `SseParser::push(&mut self, chunk: &[u8]) -> Vec<String>`: event names, comments and `data` ignored, handles `\n` and `\r\n`.
  - `backoff(attempt: u32) -> Duration`.
  - `LiveState` (managed): holds a cancellation token for the running task.
  - Commands `live_start(app)` (idempotent: a running task is left alone) and `live_stop(app)`. The task emits `live://status` and `live://event` (Global Constraints), and on `SessionExpired` emits today's session-revoked event and stops.
  - Testable core: `run_live(open: impl Fn() -> Fut, emit: impl Fn(LiveSignal), cfg: LiveTimings, cancel: CancellationToken)`, so tests inject a fake opener and short timings.
- [ ] **Step 1: Failing tests:**
  - `sse_parser_handles_chunking` (split mid-line, two events per chunk, `\r\n`, `: ping`, `event: ready` reported);
  - `backoff_schedule` (1, 2, 4, 8, 16, 32, 60, 60);
  - `live_emits_connected_events_disconnected` (fake stream: `ready`, `changed`, end → `connected`, `changed`, `disconnected`);
  - `live_404_waits_long` (next attempt uses the 10-minute timing);
  - `live_403_stops`;
  - `live_idle_stream_reconnects`;
  - `live_stop_cancels_backoff`;
  - `live_session_expired_stops_and_reports`.
- [ ] **Step 2:** `cd src-tauri && cargo test --lib live` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `cargo test --lib` all pass; `cargo fmt --check` on touched files; `cargo clippy` warnings in new code fixed.
- [ ] **Step 5:** commit `feat(live): Rust live stream with reconnect`.

### Task 4: Client — web wiring and Live label

**Files:**
- Modify: `src/stores/sync/syncStore.ts` (+ test), `src/stores/auth/authStore.ts` (+ new test `authStore.live.test.ts`), `src/components/layout/shell/SyncStatus.tsx` (+ test)

**Interfaces:**
- Consumes: Task 3 commands and events.
- Produces:
  - `syncStore` state `live: boolean`. `start()` listens to `live://status` and `live://event`:
    - `connected` → `live = true`, one `requestAll()`, timer 5 min;
    - `disconnected` → `live = false`, timer 30 s;
    - `changed` → coalesced `requestAll()`.
  - `authStore`:
    - invokes `live_start` when `serverAuthenticated` turns true (next to `reportDevice`), and `live_stop` in teardown;
    - listens to `live://event` at module load: `device_revoked` → `handleRevokedSession()`, works while locked; `account_changed` → `clearAccessToken()` then `retryServerSession()`.
  - `SyncStatus` shows "Live" instead of "Synced" when `live` is true.
- [ ] **Step 1: Failing tests:**
  - sync store: "connected switches to 5 minutes and syncs once"; "disconnected switches back to 30 seconds"; "changed bursts coalesce" (50 signals → `requestAll` called ≤ 2 times while the first is pending);
  - auth store: "starts live on server sign-in and stops on sign-out"; "device_revoked wipes while locked" (`appLocked: true` → `resetDevice` called, `appLocked` false, notice set); "account_changed rechecks the session";
  - SyncStatus: "shows Live while connected".
- [ ] **Step 2:** `npx vitest run src/stores/sync src/stores/auth/authStore.live.test.ts src/components/layout/shell` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; full `npx vitest run`; `npx tsc --noEmit`; biome on changed files.
- [ ] **Step 5:** commit `feat(live): sync on signals, wipe on revoke, Live status`.
