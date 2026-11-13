# Run snippets from the command palette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Picking a snippet or built-in command in the terminal command palette inserts it into the active pane (Enter/click), or inserts and runs it (Ctrl/Cmd+Enter).

**Architecture:** A pure helper pastes text into a pane's xterm (and sends Enter for "run"); a small orchestrator decrypts the picked snippet and resolves the active pane; the palette reports `(item, run)` and TerminalView maps results to toasts.

**Tech Stack:** React 19 + TypeScript, zustand, @xterm/xterm 6 (`paste`, `input`, `focus`), vitest, sonner.

**Spec:** `docs/superpowers/specs/2026-11-13-palette-snippets-design.md`

## Global Constraints

- Only the picked snippet is decrypted (`useSnippetStore.getState().getDecryptedSnippet(id)`); never bulk-decrypt.
- Insert = `xterm.paste(command)` with trailing newlines trimmed; run = the same, then `xterm.input("\r")`.
- Run shortcut: Ctrl+Enter, Cmd+Enter on macOS (`navigator.platform.includes("Mac")`, as in `useKeyboardShortcuts.ts:41-42`).
- Copy: footer hint `Enter to insert · Ctrl+Enter to run` (`Cmd` on macOS); toasts `Open a terminal first`, `Couldn't load this snippet`.
- On failure the palette stays open; on success it closes and focus returns to the pane.
- Commits: conventional, **no Claude/AI attribution**.

## Review Focus

1. **Palette opened with no tab / pane** (fresh terminal view) → toast "Open a terminal first", nothing thrown. Test: Task 2 `no_active_pane`.
2. **Pane exists but its session is gone** (closed/disconnected and destroyed) → same toast, no throw. Test: Task 1 `missing_session_returns_false`.
3. **Snippet whose command ends in a newline** → inserted without running. Test: Task 1 `trims_trailing_newlines`.
4. **Multi-line snippet** → pasted as one block (single `paste` call). Test: Task 1 `multi_line_is_one_paste`.
5. **Ctrl+Enter on macOS vs Cmd+Enter** → only the platform modifier runs. Test: Task 3 `run_modifier_follows_platform`.

---

### Task 1: Insert helper (session layer)

**Files:** Modify `src/lib/terminal/sessionManager.ts`; Create `src/lib/terminal/insertIntoTerminal.test.ts`

**Interfaces — Produces:**
- `export function insertIntoTerminal(term: Pick<XTerminal, "paste" | "input" | "focus">, text: string, run: boolean): void` — trims trailing `\r`/`\n`, calls `paste` once, then `input("\r")` when `run`, then `focus()`.
- `export function insertIntoPane(paneId: string, text: string, run: boolean): boolean` — `getSession(paneId)`; `false` when missing, else calls `insertIntoTerminal(session.xterm, …)` and returns `true`.

- [ ] Write failing tests with a fake `{ paste, input, focus }` (vi.fn): `trims_trailing_newlines` (`"ls -la\n"` → `paste("ls -la")`, no `input`), `multi_line_is_one_paste` (`"a\nb"` → one `paste("a\nb")`), `run_sends_enter_after_paste` (call order paste → input("\r")), `focuses_terminal`; `missing_session_returns_false` (`insertIntoPane("nope", "ls", false) === false`).
- [ ] Run `npx vitest run src/lib/terminal/insertIntoTerminal.test.ts` — FAIL.
- [ ] Implement both functions.
- [ ] Re-run — PASS. Commit `feat(terminal): insert text into a pane's terminal`.

### Task 2: Palette pick orchestration

**Files:** Create `src/lib/terminal/paletteCommand.ts`, `src/lib/terminal/paletteCommand.test.ts`

**Interfaces — Consumes:** `insertIntoPane` (Task 1). **Produces:**
- `export type PaletteItem = { snippetId?: string; command: string }`
- `export async function pickPaletteItem(item: PaletteItem, run: boolean, deps: { activePaneId: string | null; decryptSnippet(id: string): Promise<{ command: string } | null>; insert(paneId: string, text: string, run: boolean): boolean }): Promise<"ok" | "no-pane" | "decrypt-failed">` — no pane → `"no-pane"`; with `snippetId`, decrypt (null or throw → `"decrypt-failed"`) and use its command, else `item.command`; `insert` false → `"no-pane"`.

- [ ] Write failing tests: `snippet_is_decrypted_before_insert` (insert receives the decrypted command, not `item.command`), `builtin_inserts_its_command` (no decrypt call), `no_active_pane`, `decrypt_failure` (null and throw), `missing_session_is_no_pane`.
- [ ] Run `npx vitest run src/lib/terminal/paletteCommand.test.ts` — FAIL. Implement. PASS. Commit `feat(terminal): run a palette pick in the active pane`.

### Task 3: Palette UI and TerminalView wiring

**Files:** Modify `src/components/terminal/views/CommandAutocomplete.tsx`, `src/components/terminal/views/TerminalView.tsx`; Create `src/components/terminal/views/CommandAutocomplete.test.tsx`

**Interfaces — Consumes:** `PaletteItem`, `pickPaletteItem` (Task 2), `insertIntoPane` (Task 1). **Produces:** `onSelect: (item: PaletteItem, run: boolean) => void` on `CommandAutocomplete`.

Palette: snippet rows carry `snippetId`; search matches snippet `name`, `description`, `tags` (case-insensitive), built-ins by name/command as today; Enter → `onSelect(item, false)`, platform modifier+Enter → `onSelect(item, true)`, click → `onSelect(item, false)`; footer hint per Global Constraints. TerminalView `handleCommandSelect(item, run)`: active pane = the active tab's `activePaneId` from `useTerminalStore.getState()`; call `pickPaletteItem` with `decryptSnippet: id => useSnippetStore.getState().getDecryptedSnippet(id)` and `insert: insertIntoPane`; `"ok"` → close palette; `"no-pane"` → `toast.error("Open a terminal first")`; `"decrypt-failed"` → `toast.error("Couldn't load this snippet")` (palette stays open).

- [ ] Write failing tests (`// @vitest-environment happy-dom`, mock snippet store): `enter_inserts`, `ctrl_enter_runs` (non-Mac platform), `run_modifier_follows_platform` (Mac: Cmd+Enter runs, Ctrl+Enter inserts), `click_inserts`, `search_matches_tags`, `footer_hint_shown`.
- [ ] Run `npx vitest run src/components/terminal/views` — FAIL. Implement palette + TerminalView handler. PASS.
- [ ] Full checks: `npx vitest run`, `npx tsc --noEmit -p .`, `npx biome check src/components/terminal src/lib/terminal`. Commit `feat(terminal): pick snippets in the command palette to insert or run`.
- [ ] In the running app: open a terminal, Ctrl+Shift+P, pick a snippet with Enter (inserted, not run) and with Ctrl+Enter (runs).
