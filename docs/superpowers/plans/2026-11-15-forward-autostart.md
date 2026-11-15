# Forward Auto-start and Auto-reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forwards reconnect after drops and can auto-start on unlock or with a terminal.

**Architecture:**
- Rust:
  - `AutoStart` lives in `SecretFields` / the definition;
  - `ForwardStatus::Reconnecting`;
  - `reconnect_delay(attempt)`;
  - the start task loops on unexpected ends;
  - a new command `auto_start_forwards`.
- Frontend:
  - store types;
  - a form select;
  - the card status;
  - two triggers.

**Tech Stack:** Rust (tokio, tauri), React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-forward-autostart-design.md`

## Global Constraints
- **`AutoStart` (serde):**
  - values `"off" | "unlock" | "terminal"`;
  - default `"off"` when missing, so old rows keep working;
  - the field is `autoStart` in camelCase.
- **Status:** `Reconnecting(String)` → `{state:"reconnecting", error}`.
- **Delays:** 1, 2, 5, 10, then 30 s forever until stopped.
- **Owner for unlock auto-start:** `"app"`.
- **Copy:**
  - form label "Start automatically", options "Off", "When Shetu unlocks", "With a terminal to this host";
  - status "Reconnecting…";
  - card badge "Auto".
- **Checks:**
  - `cargo test --lib`;
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - biome on changed files;
  - no AI attribution.

## Review Focus
1. **A user Stop during the reconnect wait or an attempt ends the loop for good.** Pinned by the test `stop ends reconnecting`.
2. **A start failure never enters the retry loop.** Pinned by the test `start failure does not retry`.
3. **Old saved forwards without `autoStart` load as Off.** Pinned by the test `missing auto start is off`.
4. **Terminal auto-start runs again on reconnect of the pane without duplicating** ("already running" is ignored). Pinned by the test `terminal trigger skips running forwards`.

---

### Task 1: Rust model, storage, reconnect, command
- `AutoStart` enum in `model.rs`, on `ForwardInput` and `ForwardDefinition`; carried in `SecretFields`.
- `ForwardStatus::Reconnecting(String)`.
- `pub fn reconnect_delay(attempt: u32) -> Duration`.
- `runtime.rs` `start()`: after the first success, the spawned task loops. When the run ends without a stop:
  1. set `Reconnecting(err)`;
  2. sleep `reconnect_delay(n)` (cancellable);
  3. re-run `prepare` using `app.state::<LocalDb>()`, `CryptoState` and `SshSessions`;
  4. on success set `Active` and reset `n`; on failure set `Reconnecting(err)` and continue.
- `storage::auto_start_candidates(db, session, trigger, host)`: `pub enum Trigger { Unlock, Terminal(String) }`; returns matching definitions (unlock: every live forward across vaults; terminal: that host's).
- Command `auto_start_forwards(trigger: String, host_id: Option<String>, owner_pane_id: Option<String>, device_id)`: starts each, skipping running ones, and returns the number started.
- Tests:
  - `missing auto start is off`;
  - `auto start round trips`;
  - the delay sequence;
  - `Reconnecting` serialization;
  - candidates for unlock and terminal;
  - `terminal trigger skips running forwards` (pure filter over statuses);
  - `stop ends reconnecting` and `start failure does not retry`, via a supervisor helper with an injected attempt function and time (tokio test with paused time).
- [ ] → FAIL → implement → PASS → commit `feat(forwarding): auto-start setting and reconnect after drops`.

### Task 2: Frontend
- Store:
  - `autoStart` on `ForwardDefinition` / `ForwardInput`;
  - `"reconnecting"` in `ForwardStatus`;
  - `autoStartForwards(trigger, hostId?, ownerPaneId?)`.
- Form: the "Start automatically" select (form schema default `"off"`).
- Card: "Reconnecting…" (amber) and the "Auto" badge.
- `Layout.tsx`: once per run after unlock, `invoke("auto_start_forwards", { trigger: "unlock" })`.
- `sessionManager.ts`: when an SSH pane becomes connected → `invoke("auto_start_forwards", { trigger: "terminal", hostId, ownerPaneId })`, best-effort.
- Tests:
  - form saves `autoStart`;
  - the card shows the reconnecting status and badge;
  - the Layout trigger is called once;
  - the terminal trigger is invoked on connect.
- [ ] → FAIL → implement → PASS → commit `feat(forwarding): start tunnels on unlock or with a terminal, show reconnecting`.
