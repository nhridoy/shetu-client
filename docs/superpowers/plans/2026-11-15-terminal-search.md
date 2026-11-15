# Terminal Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A find bar for the focused terminal pane, built on `@xterm/addon-search`.

**Architecture:**
- Each session loads a `SearchAddon`.
- A `terminal.find` shortcut fires an open-find event (same pattern as `paletteCommand.ts`), which the active `Terminal` handles.
- `TerminalFindBar` drives the addon.

**Tech Stack:** React 19, @xterm/xterm 6 + @xterm/addon-search 0.16.0, zustand shortcut registry, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-15-terminal-search-design.md`

## Global Constraints
- **Shortcut:** `terminal.find`, label "Find in terminal", defaults `ctrl+shift+f` / `meta+f`, `whileTyping: true`.
- **Copy:**
  - menu item "Find…";
  - counts "N of M" / "No results";
  - "Invalid pattern";
  - toggle titles "Match case", "Whole word", "Use regex";
  - buttons `aria-label` "Previous match", "Next match", "Close find".
- **Decorations:** match background `#f59e0b55`; active match background `#f59e0b`; overview ruler colours the same. Needs `allowProposedApi: true` on the xterm.
- **Checks:**
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - biome on changed files only;
  - no AI attribution.

## Review Focus
1. **Invalid regex while typing** shows "Invalid pattern" and never throws. Pinned by the Task 2 test `invalid regex shows Invalid pattern`.
2. **Esc closes the bar and clears the highlights** (`clearDecorations`), and focus returns to the terminal. Pinned by the Task 2 test `Escape closes and clears`.
3. **The shortcut opens find only in the active pane.** Pinned by the Task 2 test `only the active pane opens find`.
4. **An empty query clears the highlights and shows no count.** Pinned by the Task 2 test `empty query clears`.

---

### Task 1: Addon, shortcut, open event
**Files:**
- Modify:
  - `package.json` (`bun add @xterm/addon-search@0.16.0`);
  - `src/lib/terminal/sessionManager.ts` (`searchAddon: SearchAddon` on `Session`, loaded in `createSession`, `allowProposedApi: true`);
  - `src/lib/shortcuts/registry.ts` (`terminal.find`);
  - `src/hooks/useKeyboardShortcuts.ts` (`onFind`);
  - `src/components/terminal/views/TerminalView.tsx` (pass `onFind: openFind`);
  - the two sessionManager tests (mock the addon).
- Create `src/lib/terminal/findCommand.ts` exporting `openFind(): void` and `onOpenFind(handler: () => void): () => void` (mirror `paletteCommand.ts`).
- Test: `src/lib/shortcuts/registry.test.ts` (`terminal.find` defaults) and `findCommand.test.ts` (handler fires, unsubscribe stops it).
- [ ] Write the tests → run (FAIL) → implement → run (PASS) → commit `feat(terminal): find shortcut and search add-on per session`.

### Task 2: Find bar
**Files:**
- Create `src/components/terminal/shell/TerminalFindBar.tsx` + `TerminalFindBar.test.tsx`.
- Modify:
  - `src/components/terminal/shell/Terminal.tsx` (state `finding`; `onOpenFind(() => isActive && setFinding(true))`; render the bar);
  - `src/lib/terminal/terminalContextMenu.ts` (add `openFind` param and the "Find…" item after Select All) + its test.

**Interfaces:**
- `<TerminalFindBar search={{ findNext, findPrevious, clearDecorations, onDidChangeResults }} onClose={() => void} />`, given the session's `SearchAddon`.
- `onClose` focuses the xterm.
- The last query is kept in a module variable.

- [ ] Tests (with a fake addon):
  - typing calls `findNext(query, {caseSensitive, wholeWord, regex, incremental: true, decorations})`;
  - a results event `{resultIndex: 2, resultCount: 12}` shows "3 of 12"; `resultCount: 0` shows "No results";
  - Enter → `findNext`; Shift+Enter → `findPrevious`;
  - toggles flip their options;
  - `invalid regex shows Invalid pattern` (fake `findNext` throws `SyntaxError`);
  - `Escape closes and clears`;
  - `empty query clears`;
  - `only the active pane opens find` (Terminal-level, with `openFind`);
  - the context menu has "Find…" calling `openFind`.
- [ ] Run (FAIL) → implement → run (PASS) + the full suite + tsc + biome → commit `feat(terminal): find bar with match count and case/word/regex toggles`.
