# Snippet Variables and Bulk Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `{{name}}` snippet variables, "Run on hosts" from the Snippets list, and "Run in all tabs" from the palette.

**Architecture:**
- Pure helpers parse and fill variables.
- A promise-based ask store plus a dialog mounted in `Layout` collects the values.
- `runWhenConnected` sends a command once a pane connects.
- The palette and the Snippets list call these.

**Tech Stack:** React 19, zustand, react-hook-form-free small forms, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-15-snippet-variables-bulk-run-design.md`

## Global Constraints
- **Variable regex:** `/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g`. Unique names, in order of first appearance.
- **Copy:**
  - dialog title "Fill in snippet";
  - buttons "Continue" / "Cancel";
  - row button title "Run on hosts";
  - dialog title "Run on hosts";
  - buttons "Save targets", "Run";
  - toasts: `Ran in ${n} terminal${s}`, "No connected terminals", "Pick at least one host";
  - palette footer adds `${Ctrl|Cmd}+Shift+Enter to run in all tabs`.
- **Waiting for a connection:** run once on the first `connected`. Stop waiting after 120 s, or when the pane disappears or reaches `failed`.
- **Checks:**
  - `bunx vitest run`;
  - `bunx tsc --noEmit`;
  - biome on changed files;
  - no AI attribution.

## Review Focus
1. **Cancelling the variables form sends nothing anywhere.** Pinned by the tests `cancel sends nothing` (palette and run-on-hosts).
2. **A value containing a newline or control characters is never typed raw.** `insertIntoTerminal` already strips control characters, and a run always ends in a single Enter. Pinned by the test `filled values are inserted through the safe insert`.
3. **A pane closed before it connects never gets the command later,** and the subscription is cleaned up. Pinned by the test `closed pane never receives`.
4. **Saving targets keeps the snippet's command** (the payload is merged). Pinned by the test `save targets keeps the command`.

---

### Task 1: Variables

**Files:**
- Create:
  - `src/lib/snippets/variables.ts`: `snippetVariables(command: string): string[]`, `fillSnippet(command: string, values: Record<string,string>): string`;
  - `src/stores/snippets/snippetVariablesStore.ts`: `askSnippetVariables(names: string[]): Promise<Record<string,string> | null>`, with session memory of the last values;
  - `src/components/snippets/SnippetVariablesDialog.tsx` (mounted in `Layout.tsx`).
- Modify:
  - `src/lib/terminal/paletteCommand.ts`: `pickPaletteItem` gains a `deps.askVariables` and returns `"cancelled"` when the user cancels;
  - `TerminalView.tsx`: passes `askSnippetVariables`; no toast on `"cancelled"`.
- Tests:
  - parse/fill (duplicates, spaces, no variables, unknown placeholders left as typed);
  - the dialog prefills last values, Enter resolves, Esc resolves `null`;
  - palette: `cancel sends nothing`, and the variables are filled before insert.
- [ ] → FAIL → implement → PASS → commit `feat(snippets): {{name}} variables with a fill-in form`.

### Task 2: Run in all tabs
**Files:**
- Modify:
  - `src/lib/terminal/paletteCommand.ts`: export `runInAllTabs(command, deps: {tabs, insert}): number`, which counts the connected panes run in;
  - `CommandAutocomplete.tsx`: Ctrl/Cmd+Shift+Enter → `onSelect(item, run, { all: true })`, plus the footer hint;
  - `TerminalView.tsx`: resolves the snippet (decrypt + variables) → `runInAllTabs` → toast.
- Tests:
  - `runInAllTabs` skips disconnected panes and returns the count;
  - the palette key mapping and footer;
  - zero connected → "No connected terminals".
- [ ] → FAIL → implement → PASS → commit `feat(snippets): run a snippet in all open terminals from the palette`.

### Task 3: Run on hosts
**Files:**
- Modify:
  - `src/stores/snippets/snippetStore.ts`: `targets?: string[]` in the decrypted snippet; `updateSnippet` merges `targets`;
  - `src/components/snippets/lists/SnippetList.tsx`: row button "Run on hosts".
- Create:
  - `src/components/snippets/RunOnHostsDialog.tsx`;
  - `src/lib/terminal/runWhenConnected.ts`: `runWhenConnected(tabId, paneId, command): () => void`;
  - `src/lib/snippets/runOnHosts.ts`: `runOnHosts(snippetId, hostIds): Promise<"ok" | "cancelled" | "no-hosts" | "decrypt-failed">`, which resolves variables once, `addTab`s per host and calls `runWhenConnected`.
- Tests:
  - `save targets keeps the command`;
  - `runWhenConnected` sends once on connect, `closed pane never receives`, and times out;
  - `runOnHosts` opens a tab per host and uses the same filled command; `cancel sends nothing`;
  - the dialog preselects saved targets, filters, Save targets calls update, Run calls runOnHosts and navigates;
  - `filled values are inserted through the safe insert` (`insertIntoPane` with `run=true`).
- [ ] → FAIL → implement → PASS → commit `feat(snippets): run a snippet on picked hosts, one tab each, with saved targets`.
