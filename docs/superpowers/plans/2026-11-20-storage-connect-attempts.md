# Storage Connect Attempts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A storage connect saves its pane session only while it is still that pane's latest attempt, so an abandoned connect can't replace or close a newer one.

**Architecture:** `StorageSessions` hands each connect an attempt ticket and remembers the pane's latest; disconnect and sign-out forget tickets. The web hook stops cleaning up after the fact and treats a refused connect on a closed pane as a quiet cancel.

**Tech Stack:** Rust (Tauri v2), React 19 hook, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-storage-connect-attempts-design.md`

## Global Constraints

- `op(sid, account_id)` stays account-bound; no change to other storage commands.
- No new command arguments for `storage_connect` / `storage_disconnect`.
- `rustfmt --edition 2021` on touched files only; `biome check --write` on touched files only.

## Review Focus

- Reconnect to the same pane right after disconnect (no stale connect running): the new connect must still save (newest ticket wins).
- Two panes connecting at once: tickets are per pane; one pane's disconnect must not refuse the other's connect.
- Sign-out while a connect runs: refused, as today (`a_connect_from_before_sign_out_is_not_kept` keeps passing in its new form).
- A first connect with no certificate question, disconnected mid-flight: refused in Rust, no error box on the web side.
- The normal cert → trust → retry path: the retry's own ticket is the latest, so it saves.

---

### Task 1: Attempt tickets in `StorageSessions`

**Files:**
- Modify: `src-tauri/src/storage/sessions.rs` (struct, `insert_if`, `remove`, `clear`, `storage_connect`, tests)

**Interfaces:**
- Produces: `StorageSessions::begin(&self, sid: &str) -> u64`; `insert_if(&self, attempt: u64, sid: String, r: StorageRef, op: Remote) -> bool`; `remove(&self, sid: &str)` (session + ticket); `clear(&self)` (both maps). `generation()` and the `generation` field are removed. `storage_connect` returns `Err("The pane was closed while connecting")` when `insert_if` refuses.

- [ ] **Step 1: Write the failing tests** (in the existing `tests` module; reuse its `op()`/`StorageRef` helpers)
  - `a_connect_after_its_pane_closed_is_not_kept`: `let a = s.begin("pane-1"); s.remove("pane-1"); assert!(!s.insert_if(a, ...))`.
  - `an_older_connect_never_replaces_a_newer_one`: `let a = s.begin("pane-1"); let b = s.begin("pane-1"); assert!(s.insert_if(b, ..account "b"..)); assert!(!s.insert_if(a, ..account "a"..)); assert_eq!(s.get("pane-1").unwrap().0.account_id, "b")`.
  - `tickets_are_per_pane`: `let a = s.begin("pane-1"); let b = s.begin("pane-2"); s.remove("pane-2"); assert!(s.insert_if(a, "pane-1"..))` and `!s.insert_if(b, "pane-2"..)`.
  - Rewrite `a_connect_from_before_sign_out_is_not_kept`: `let a = s.begin("pane-1"); s.clear(); assert!(!s.insert_if(a, ..)); let b = s.begin("pane-1"); assert!(s.insert_if(b, ..))`.
  - Other existing tests: replace `s.insert_if(s.generation(), sid, ..)` with `s.insert_if(s.begin(sid), sid, ..)`.

- [ ] **Step 2: Run and see them fail**
  Run: `cargo test --lib storage::sessions` (from `src-tauri`). Expected: compile error, no method `begin`.

- [ ] **Step 3: Implement** — `open` and `latest: HashMap<String, u64>` under one `Mutex` (a struct or tuple), plus `next: AtomicU64`; `begin` stores `next+1` as the pane's latest; `insert_if` stores only when `latest.get(sid) == Some(&attempt)`; `remove` drops both entries; `clear` empties both. `storage_connect` calls `begin(&session_id)` before loading the account.

- [ ] **Step 4: Run and see them pass**
  Run: `cargo test --lib storage::` then `cargo clippy --lib --tests` (no warnings in `storage/`). Expected: PASS.

- [ ] **Step 5: Commit** `fix(storage): a pane keeps only its latest connect attempt`

### Task 2: The hook drops its after-the-fact cleanup

**Files:**
- Modify: `src/hooks/sftp/useFileOperations.ts` (storage branch of `ensureProvider`)
- Test: `src/hooks/sftp/useFileOperations.test.tsx`

**Interfaces:**
- Consumes: Task 1's refusal (`storage_connect` rejects once the pane was disconnected after the connect began).

- [ ] **Step 1: Write the failing test** `a connect refused because the pane closed stops quietly`: first `storage_connect` returns a pending promise; call `ensureProvider()`, then `disconnect()`, then reject that promise with `"The pane was closed while connecting"`. Expect the result to be `ConnectCancelled`, `ops.connectionErrorModal.open === false`, `ops.connectionError === null`.
  Replace the two tests that asserted the post-hoc cleanup ("a disconnect during the retry closes the session it reopened", "a stale retry leaves alone the session a newer connect opened in the pane") with one: `a retry finishing after disconnect calls nothing more`: the retry resolves after `disconnect()`; expect `ConnectCancelled` and no `storage_disconnect` call after the retry's `storage_connect`.

- [ ] **Step 2: Run and see it fail**
  Run: `bunx vitest run src/hooks/sftp/useFileOperations.test.tsx`. Expected: the new quiet-stop test fails (error modal shown / error set).

- [ ] **Step 3: Implement** — in the storage branch, wrap each `connect()` so a rejection while `disconnectsRef.current !== started` becomes `ConnectCancelled("The pane was closed")`; after a successful connect with a changed counter, throw `ConnectCancelled` without invoking `storage_disconnect`: a connect that finished before the disconnect had its session removed by that disconnect, and one that finished after was refused by Rust. Remove the `getProvider` guard and the cleanup `invoke`; drop the `getProvider` import if unused.

- [ ] **Step 4: Run and see it pass**
  Run: `bunx vitest run` and `bunx tsc --noEmit -p .`. Expected: all pass, tsc clean.

- [ ] **Step 5: Commit** `fix(sftp): a storage connect the pane abandoned stops quietly`
