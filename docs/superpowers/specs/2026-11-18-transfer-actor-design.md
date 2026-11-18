# Transfer manager as a single owner — design and plan

Date: 2026-11-18 · Size: refactor inside PR #50 (no behaviour change) · Status: draft for approval

## Why

The first version of the transfer manager (`src-tauri/src/transfers/manager.rs`) keeps its state
in several mutexes:

- `queue`
- `tokens`
- `prefer`
- `running`
- `owned`
- `epoch`

These are touched by Tauri commands, by the scheduling loop and by every running transfer task.
Each review round found another interleaving between two of them (cancel vs start, wipe vs
enqueue, idle close vs reuse, pause vs publish, clear vs cleanup…). Each fix added a lock or a
re-check, and each re-check opened the next window. Tests checked rules, not interleavings.

Approach B (chosen by the user): one task owns all transfer state. Everything else sends it
messages. Races between commands, the scheduler and transfers then can't happen by
construction. The whole decision logic becomes a plain, synchronous state machine that tests can
drive through any ordering of events.

## Decided

- **Behaviour stays exactly as built and reviewed in PR #50.** That covers the spec
  `2026-11-18-resumable-transfers-design.md` plus every review fix:
  - `.part` naming and resume rules, retries, restore after restart;
  - endpoint check, pane-session bypass on retry;
  - publish never interrupted and "published means Done";
  - cancel cleanup, no-replace publish, idle close, dead-session drop, wipe fencing, tolerant
    load.
- **Tauri commands and events stay the same:**
  - commands: `transfer_enqueue`, `transfer_list`, `transfer_pause`, `transfer_resume`,
    `transfer_resume_all`, `transfer_retry`, `transfer_cancel`, `transfer_clear_finished`;
  - events: `transfers://changed`, `transfers://reset`.
  - The web side doesn't change.
- **Unchanged files:** `model.rs`, `queue.rs`, `store.rs` and `io.rs`, apart from small API
  touch-ups.

## Design

### 1. `actor.rs`: the state machine (pure, synchronous, no Tauri)

`State<S>` owns:

- `queue: Queue`;
- `runs: HashMap<id, Run<S>>` where `Run = { run: u64, token: CancellationToken, held: Vec<sid> }`;
- `prefer: HashMap<id, (Option<sid>, Option<sid>)>`;
- `owned: HashMap<sid, Instant>`;
- `epoch: u64`.

`S` is the session handle type: `Arc<SftpSession>` in the app, a plain `String` in tests.

`State::handle(msg, now, env: &mut impl Env<S>) -> Vec<Effect<S>>`.

`Msg` comes in two groups.

**From commands:**

- `Enqueue { jobs, prefer, epoch }`: rejected if `epoch` is stale.
- `Pause(id)`, `Resume(id)`, `ResumeAll`, `Retry(id)`, `Cancel(id)`, `ClearFinished`.
- `List` and `Epoch`: answered through a reply effect.
- `Wipe`.

**From the scheduler and transfers:**

- `Tick`;
- `Progress { id, run, written, speed }`;
- `Connected { id, run, sid }`: a transfer opened a manager-owned connection.
- `NeedSession { id, run, side }`: a reuse lookup the transfer asks for after taking its
  per-host connect lock;
- `Ended { id, run, end: RunEnd }`.

**`Env<S>` (sync):**

- `unlocked()`;
- `find(host, prefer, pane_ok) -> Option<(sid, HostRef, S)>`;
- `take(sid) -> Option<S-ish>` (removes from `SftpSessions`).

The app implements it over `SftpSessions` and `CryptoState`. Tests use a scripted fake.

**`Effect<S>`:**

- `Emit(jobs)`, `Save(jobs)`, `Delete(ids)`, `ClearDb`, `EmitReset`;
- `Start { job, run, token, src: Option<(sid, S)>, dest: Option<(sid, S)>, pane_ok }`;
- `Session { id, run, side, found: Option<(sid, S)> | Refused(JobError) }`;
- `RemovePart(job)`, `Close(sessions)`, `Reply(...)`.

**Rules,** every one applied inside `handle`, so no interleaving is possible:

- **Start:** `startable` → `mark_active` → new run + token. The reuse lookup (find, endpoint
  check, mark owned session used) happens in the same step, and the results go in `Start`.
- **`Ended` for a run that isn't current:** ignored.
- **`Ended` for the current run:** apply `Queue::finish`, or set waiting. If the job is
  Cancelled, emit `RemovePart`. A connection error makes the run's owned sessions be taken and
  closed. Then drop the run.
- **`Cancel`:**
  - running: Cancelled + token cancelled; the run's `Ended` triggers the cleanup;
  - not running: `RemovePart` now.
- **`ClearFinished`:** skips ids with a live run.
- **`Wipe`:** cancel all tokens, forget the queue, the runs and `prefer`, `epoch += 1`,
  `ClearDb`, `EmitReset`.
- **`Tick`:**
  - due retries;
  - wake unlock and host waiters;
  - retire idle owned sessions (skipping ones held by runs) via `take` + `Close`;
  - start startable jobs.
- **`Progress`** for the current run: update, emit (throttled), save every 5 s.

### 2. `worker.rs`: one transfer's I/O (async, no shared state)

Given a `Start`, it:

1. connects anything missing, for saved hosts only:
   - per-host connect lock, then `NeedSession` round-trip, then `connect_saved_session`;
   - sends `Connected`;
2. stats, discards stale `.part`, copies (racing the token);
3. publishes (not raced);
4. sends `Ended`.

It never reads or writes queue state.

### 3. `manager.rs`: Tauri glue

- An mpsc channel and one loop task: receive msg → `state.handle` → run effects.
  - DB writes and emits run inline; they're short.
  - Spawns, closes and part removals are spawned.
  - A 1 s `Tick` fires only while busy.
- Commands send a message and await their reply over a `oneshot`.
- `transfer_enqueue` gets `Epoch`, stats the files, then sends `Enqueue`.
- `wipe()` (from `wipe_local_data`) sends `Wipe` and waits for it to be applied.

### What goes away

From `manager.rs`:

- the six shared mutexes;
- `RunTokens`, `complete_run`, `activate`, `cancel_job`, `commit_enqueue`, `wipe_queue`,
  `OwnedSessions`;
- the lock-order comments.

Their tests become `State` tests.

## Tests (the point of this change)

The existing pure tests stay (`model`, `queue`, `store`, `io`, helpers). New `actor.rs` tests
drive `State` through the interleavings the reviews found, each as an explicit message
sequence:

1. Cancel before start / after start / during publish (`Ended(Ok)` after `Cancel` → Done).
2. Pause → Resume while a run is still ending (`Ended` of the old run ignored, no second run).
3. `ClearFinished` between cancel and the run's `Ended` (row kept, `RemovePart` emitted).
4. `Wipe` between `Epoch` and `Enqueue` (rejected), and `Wipe` with live runs (later `Ended`
   ignored, nothing saved).
5. Idle close vs reuse (a session handed to a run in `Start` is never retired while held).
6. Connection error on an owned session (taken and closed; the next start can't find it).
7. Endpoint mismatch / missing metadata at start (fails closed).
8. Retry after failure skips pane sessions for saved hosts.
9. Restore, retry schedule, unlock and host wake-ups, 3-at-a-time.

## Plan

1. **`actor.rs`:** `State`, `Msg`, `Effect`, `Env`, and `handle`, written test-first from the list
   above. `queue.rs` stays the row state machine.
2. **`worker.rs`:** acquire/copy/publish, moved out of `manager.rs` mostly unchanged, with the
   messages above.
3. **`manager.rs`:** rewrite as the loop and the commands. Delete the old shared-state code and
   its tests, now covered by `actor.rs` tests.
4. **Verify:**
   - full Rust and web suites, clippy-clean build;
   - push to PR #50 and reply on the PR describing the restructure.

The manual SSH check is still the merge gate.

## Left to the builder

Exact enum shapes, channel sizes, and how `List`/`Epoch` replies are carried.
