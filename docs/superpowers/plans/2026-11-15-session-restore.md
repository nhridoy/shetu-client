# Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reopen the last tabs and splits, connected, on launch.

**Architecture:**
- `src/lib/terminal/sessionRestore.ts` snapshots the terminal store into plugin-store `session.json` (per account, debounced).
- At startup it restores through `launchWorkspace`.
- `Layout.tsx` wires it in after unlock and the host fetch; logout clears it.

**Tech Stack:** zustand, @tauri-apps/plugin-store, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-session-restore-design.md`

## Global Constraints
- **Store:** file `session.json`, key `last:<accountId>`.
- **Saved value:** `{ tabs: {title, root}[], activeIndex: number, workspaceId: string | null, workspaceName: string | null }`. Roots come from `serializePresetRoot` (no secrets).
- **Save:** debounced 500 ms. Empty tabs save `tabs: []`.
- **Restore:**
  - runs once per app run;
  - only if the store has no tabs;
  - runs after the `fetchHosts` for the current vault resolves;
  - re-selects `activeIndex`, clamped.
- **Logout** clears the whole file (best-effort, in `runTeardown`).
- **Checks:**
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - biome on changed files;
  - no AI attribution.

## Review Focus
1. **Restore never replaces tabs the user already opened** (for example a deep link). Pinned by the test `restore skips when tabs are open`.
2. **A corrupt or partial saved value never crashes startup.** Pinned by the test `junk saved value is ignored`.
3. **Account A's layout is never shown to account B.** Pinned by the test `layouts are per account`.
4. **Restore waits for hosts.** Restoring before they load would mark every pane "Missing host". Pinned by the test `restore waits for hosts`.

---

### Task 1: sessionRestore module
**Files:** Create `src/lib/terminal/sessionRestore.ts` and `sessionRestore.test.ts`.

**Interfaces:**
- `snapshotSession(state: {tabs, activeTabId, activeWorkspaceId, activeWorkspaceName}): SavedSession`;
- `startSessionPersistence(accountId: string): () => void` (subscribes to `useTerminalStore`, debounced save);
- `restoreLastSession(accountId: string, vaultId: string | undefined): Promise<boolean>`;
- `clearSavedSessions(): Promise<void>`.

- [ ] Tests (mock plugin-store with an in-memory map; fake timers for the debounce):
  - snapshot round-trip;
  - a change persists after 500 ms;
  - `restore reopens tabs and the active one`;
  - `restore skips when tabs are open`;
  - `junk saved value is ignored`;
  - `layouts are per account`;
  - `restore waits for hosts` (fetchHosts called and awaited before `launchWorkspace`);
  - clear empties the store.
- [ ] → FAIL → implement → PASS → commit `feat(terminal): save the open layout and reopen it on launch`.

### Task 2: Wire into the app
**Files:** Modify `src/components/layout/shell/Layout.tsx` and `src/stores/auth/authStore.ts`.
- `Layout.tsx`: when `isUnlocked` and an account id is known, call `startSessionPersistence(id)` (cleanup on change), then, once per run, `restoreLastSession(id, currentVaultId)`.
- `authStore.ts`: add `await attempt("last session", clearSavedSessions)` in `runTeardown`.
- [ ] Test: logout teardown calls `clearSavedSessions` (authStore deletion/logout test style).
- [ ] Full suite → commit `feat(terminal): reopen last tabs after unlock; forget them on logout`.
