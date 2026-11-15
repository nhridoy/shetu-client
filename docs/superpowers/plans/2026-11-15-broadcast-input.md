# Broadcast Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tab toggle that sends one pane's input to every connected pane in the tab.

**Architecture:**
- `TerminalTab.broadcast` lives in the terminal store.
- A pure `broadcastTargets(tab, sourcePaneId)` picks the receiving panes.
- `Session.send` holds each session's writer; the session `onData` fans out.
- The UI marks the panes and the tab.

**Tech Stack:** React 19, zustand, xterm 6, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-15-broadcast-input-design.md`

## Global Constraints
- **Shortcut:** `terminal.broadcast`, label "Broadcast input", defaults `ctrl+shift+b` / `shift+meta+b`, `whileTyping: true`.
- **Copy:**
  - menu item "Broadcast Input" (label "✓ Broadcast Input" when on);
  - pane badge "Broadcasting";
  - tab icon `title` "Broadcasting input".
- **Style:** pane outline `ring-2 ring-inset ring-amber-500/70` while broadcasting; the tab icon is amber.
- **Targets:** other leaves of the same tab with `connectionStatus === "connected"`; never the source pane.
- **Checks:**
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - biome on changed files;
  - no AI attribution.

## Review Focus
1. **The source pane never receives its own input twice.** Pinned by the Task 1 test `targets exclude the source`.
2. **Disconnected or reconnecting panes are skipped.** Pinned by the Task 1 test `only connected panes receive`.
3. **Turning broadcast off stops the fan-out immediately** (state is read at send time). Pinned by the Task 2 test `fan-out follows the toggle`.
4. **Closing a pane, or splitting a new one while broadcast is on,** gives correct targets (computed live from the tree). Pinned by the Task 1 test `targets follow the tree`.

---

### Task 1: Store toggle, targets, fan-out
**Files:**
- Modify:
  - `src/stores/terminal/terminalStore.ts`: `broadcast?: boolean` on `TerminalTab`; `toggleBroadcast(tabId: string): void`; `export function broadcastTargets(tab: TerminalTab, sourcePaneId: string): string[]`;
  - `src/lib/terminal/sessionManager.ts`: `send: (data: string) => void` on `Session`, set in both connect paths; `onData` calls `session.send(data)`, then `getSession(id)?.send(data)` for each `broadcastTargets` of the session's tab (tab found by `params.tabId`).
- Test:
  - store tests: `targets exclude the source`, `only connected panes receive`, `targets follow the tree`, `toggleBroadcast flips one tab`;
  - a sessionManager test (existing xterm mock style): `fan-out follows the toggle`.
- [ ] Tests → FAIL → implement → PASS → commit `feat(terminal): broadcast one pane's input to the other panes in its tab`.

### Task 2: Shortcut, menu, indicators
**Files:**
- Modify:
  - `src/lib/shortcuts/registry.ts` (+ registry/KeyboardTab counts 29→30);
  - `src/hooks/useKeyboardShortcuts.ts` (`onBroadcast`);
  - `TerminalView.tsx` (toggles the active tab);
  - `terminalContextMenu.ts` (optional `broadcast?: { on: boolean; toggle: () => void }`; item after "Find…") + test;
  - `Terminal.tsx` (passes it);
  - `Pane.tsx` (amber ring + "Broadcasting" badge when its tab broadcasts) + test;
  - `SortableTab.tsx` (icon `BroadcastIcon` with `title` "Broadcasting input").
- [ ] Tests:
  - registry default;
  - menu item label and toggle;
  - pane shows the badge and ring only while its tab broadcasts;
  - the tab icon shows only while broadcasting.
- [ ] → FAIL → implement → PASS + full suite → commit `feat(terminal): broadcast toggle, menu item and pane indicators`.
