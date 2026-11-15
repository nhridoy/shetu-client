# App-wide Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow Quick Connect into one app-wide palette for hosts, local shells, snippets, actions, pages and create actions.

**Architecture:** `useShortcut` handlers also answer a palette request (DOM event) and record which ids are live; a pure `buildPaletteSections` filters everything; `CommandPalette` (in Layout) renders and dispatches picks. Terminal snippet picks go through a picker the terminal view registers; elsewhere a snippet opens Run on hosts.

**Tech Stack:** React 19, zustand, react-router, react-hotkeys-hook, vitest + happy-dom, biome.

**Spec:** `docs/superpowers/specs/2026-11-16-command-palette-design.md`

## Global Constraints

- Open binding: `app.quickConnect` (Ctrl+Shift+K / ⌘K), label "Command palette"; id and macOS menu item `quick-connect` unchanged.
- `terminal.palette` (Ctrl+Shift+P / ⇧⌘P) opens the same palette filtered to snippets; label stays "Snippets palette".
- Section order: Hosts, Local shells, Snippets, Actions. Empty query: each section capped at 8 rows.
- Search: case-insensitive substring. Hosts name/address; shells name/path; snippets name/description/tags; actions label.
- `palette: false`: `app.quickConnect`, `terminal.palette`, `terminal.copy`, `terminal.paste`, `files.copy`, `files.cut`, `files.paste`, `files.selectAll`, `files.rename`, `files.delete`, `files.up`, `editor.copyPath`, `editor.rename`, `editor.delete`.
- Pages: "Go to Hosts / Workspaces / Snippets / Keychain / History / Teams" (the sidebar's 6).
- Create: "New host", "New group", "New snippet", "New key" → `?new=host|group|snippet|key`; "Port forwarding" only for the active pane when it's a connected SSH host.
- Snippet keys in the terminal view: Enter insert, Mod+Enter run, Mod+Shift+Enter run in all tabs (kept from today). Outside: Enter opens Run on hosts.
- Never run `biome check --write` on folders — changed files only. No AI attribution in commits.

## Review Focus

- Terminal view not focused/active (route ≠ /terminal) while TerminalView stays mounted → terminal actions must not be listed (filter by `activeContext`), tested in Task 2.
- Shortcut recording in Settings (`recording` true) → palette requests must not fire handlers, tested in Task 1.
- Palette opened twice / snippets mode then plain open → mode resets to "all", tested in Task 3.
- `?new=` with a value a page doesn't own (e.g. `?new=key` on /hosts) → ignored, param left alone, tested in Task 4.
- Direct `user@host:port` entry still works in the merged palette, tested in Task 3.

---

### Task 1: Shortcut actions from the palette

**Files:**
- Create: `src/lib/shortcuts/actions.ts`, `src/lib/shortcuts/actions.test.ts`
- Modify: `src/hooks/useShortcut.ts`, `src/lib/shortcuts/registry.ts` (add `palette?: false` to `ShortcutDef`, mark the 14 ids, relabel `app.quickConnect`)
- Test: `src/hooks/useShortcut.test.tsx` (create if absent)

**Interfaces:**
- Produces: `runShortcutAction(id: ShortcutId): boolean` (true if a live handler ran); `liveShortcutIds(): ReadonlySet<ShortcutId>`; internal `registerShortcutHandler(id, run: () => void): () => void` used by `useShortcut`.

- [ ] **Step 1: Failing tests**
  - `actions.test.ts`: `registerShortcutHandler("terminal.find", fn)` → `liveShortcutIds().has("terminal.find")` true, `runShortcutAction("terminal.find")` true and `fn` called once; after dispose → not live, `runShortcutAction` false. Two registrations of one id → live until both disposed.
  - `useShortcut.test.tsx` (renderHook-style with `createRoot`): mounted `useShortcut("terminal.find", cb)` → `runShortcutAction` calls `cb`; with `{ enabled: false }` → not live; with store `bindings["terminal.find"] = ""` (unbound) → still live and runs; with `useShortcutStore.setState({ recording: "x" })` → not live; unmount → not live.
  - Registry: `SHORTCUTS.filter(d => d.palette === false).map(d => d.id)` equals the 14 ids from Global Constraints; `app.quickConnect` label is "Command palette".
- [ ] **Step 2: Run** `npx vitest run src/lib/shortcuts src/hooks/useShortcut.test.tsx` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** `actions.ts`: module-level `Map<ShortcutId, Set<() => void>>`; run calls every handler of the id. `useShortcut`: `useEffect` registering when `!recording && options.enabled !== false` (ignores binding, shadowing and the mac-menu flag — the handler itself routes, e.g. new tab via `dispatchAppAction`), calling the latest callback through a ref with `new KeyboardEvent("keydown")`. Ruling vs spec: no separate `dispatchAppAction` path for menu items — the same handler runs either way.
- [ ] **Step 4: Run** same command — Expected: PASS. Then `npx vitest run src/components/settings` (shortcut label tests) — fix any label fixture.
- [ ] **Step 5: Commit** `feat(palette): run shortcut actions by id`

### Task 2: Palette sections (pure)

**Files:**
- Create: `src/lib/palette/sections.ts`, `src/lib/palette/sections.test.ts`
- Modify: `src/components/layout/shell/AppSidebar.tsx` (export its items array as `SIDEBAR_ITEMS`)

**Interfaces:**
- Consumes: `SHORTCUTS`, `ShortcutDef`, `liveShortcutIds()` (passed in as a set).
- Produces:
```ts
export type PaletteRow =
  | { kind: "direct"; query: string }
  | { kind: "host"; host: Host }
  | { kind: "shell"; shell: ShellInfo }
  | { kind: "snippet"; item: PaletteItem; label: string; detail?: string }
  | { kind: "action"; id: ShortcutId; label: string }
  | { kind: "page"; path: string; label: string }
  | { kind: "create"; target: "host" | "group" | "snippet" | "key"; label: string }
  | { kind: "portForwarding"; paneId: string; label: string };
export interface PaletteSection { title: "Hosts" | "Local shells" | "Snippets" | "Actions"; rows: PaletteRow[] }
export function buildPaletteSections(input: {
  query: string; mode: "all" | "snippets";
  hosts: Host[]; shells: ShellInfo[];
  snippets: Snippet[]; builtins: { name: string; command: string; description: string }[] | null;
  live: ReadonlySet<ShortcutId>; activeContext: ShortcutContext | null;
  portForwardingPaneId: string | null;
}): PaletteSection[]
```
- [ ] **Step 1: Failing tests** in `sections.test.ts`:
  - empty query, 10 hosts → Hosts has 8 rows; query "10.0.0.4" finds the host by address; query keeps all matches (no cap).
  - snippet found by tag; built-ins listed after snippets only when `builtins` non-null.
  - `mode: "snippets"` → only the Snippets section.
  - actions: live `terminal.find` + `activeContext "terminal"` → row "Find in terminal"; same with `activeContext null` → absent; live `terminal.copy` → never listed; `app.settings` live with any context → listed; not-live id → absent.
  - pages: query "keych" → "Go to Keychain" row with path `/keys`; creates: query "new" → New host/group/snippet/key; "Port forwarding" only when `portForwardingPaneId` set.
  - `direct` row first in Hosts when query has no exact host name/address match (as Quick Connect today); empty sections omitted.
- [ ] **Step 2: Run** `npx vitest run src/lib/palette` — Expected: FAIL.
- [ ] **Step 3: Implement** `buildPaletteSections`. Actions section order: shortcut actions, pages, creates, port forwarding. Cap 8 per section only when query is empty.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(palette): build palette sections`

### Task 3: CommandPalette replaces Quick Connect and the snippets palette

**Files:**
- Rename: `src/components/terminal/views/QuickConnect.tsx` → `src/components/layout/palette/CommandPalette.tsx` (and its test → `CommandPalette.test.tsx`)
- Delete: `src/components/terminal/views/CommandAutocomplete.tsx` + test (move its built-in list to `BUILTIN_COMMANDS` in `src/lib/terminal/paletteCommand.ts`)
- Modify: `src/lib/terminal/paletteCommand.ts`, `src/components/terminal/views/TerminalView.tsx`, `src/components/layout/shell/Layout.tsx`, callers of `openCommandPalette` (`terminalContextMenu.ts`)

**Interfaces:**
- Consumes: Task 1 `runShortcutAction`, `liveShortcutIds`; Task 2 `buildPaletteSections`, `PaletteRow`.
- Produces in `paletteCommand.ts`:
  - `openCommandPalette(mode?: "all" | "snippets"): void`; `onOpenCommandPalette(handler: (mode: "all" | "snippets") => void): () => void` (event detail carries mode, default "all").
  - `type SnippetPicker = (item: PaletteItem, run: boolean, all: boolean) => Promise<boolean>` (true = done, close); `setTerminalSnippetPicker(p: SnippetPicker | null): void`; `terminalSnippetPicker(): SnippetPicker | null`.
  - `BUILTIN_COMMANDS` (the current common-command list, unchanged values).
- `CommandPalette` props: same as QuickConnect's (`onConnect`, `onConnectLocal`) plus `onNavigate(path: string): void` (Layout passes `guarded(() => navigate(path))`).

- [ ] **Step 1: Failing tests** in `CommandPalette.test.tsx` (keep the existing Quick Connect cases: open on shortcut/app action, host Enter connects, shell Enter, direct `root@1.2.3.4:2222` connects):
  - registered live `terminal.find` + context terminal → typing "find" + Enter calls the handler and closes.
  - "Go to Keychain" Enter → `onNavigate("/keys")`; "New host" Enter → `onNavigate("/hosts?new=host")`.
  - snippet Enter with a registered picker → picker called `(item, false, false)`; Mod+Enter → `(item, true, false)`; Mod+Shift+Enter → `(item, true, true)`; picker resolves false → palette stays open.
  - snippet Enter with no picker → Run on hosts dialog shown with the snippet name.
  - `openCommandPalette("snippets")` → only Snippets section, placeholder "Search snippets"; close then `openCommandPalette()` → all sections.
  - Footer: host row "Enter to connect"; snippet row in terminal "Enter to insert · Ctrl+Enter to run · Ctrl+Shift+Enter to run in all tabs"; outside "Enter to run on hosts".
- [ ] **Step 2: Run** `npx vitest run src/components/layout/palette` — Expected: FAIL.
- [ ] **Step 3: Implement.** Palette: computes live set and `activeContext` when it opens; flat index across sections for ↑/↓; aria-label "Command palette"; placeholder "Search hosts, actions, snippets or type user@host:port". TerminalView: drop `CommandAutocomplete` and its state; `handleCommandSelect` returns boolean (true where it used to close); register it with `setTerminalSnippetPicker` in an effect (clear on unmount); `onCommandPalette: () => openCommandPalette("snippets")`. Layout renders `CommandPalette`. Context menu calls `openCommandPalette("snippets")`.
- [ ] **Step 4: Run** `npx vitest run` (whole suite; fix TerminalView/Layout tests that referenced the old components) — Expected: PASS. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(palette): one app-wide command palette`

### Task 4: Create actions and port forwarding

**Files:**
- Create: `src/hooks/useNewParam.ts`, `src/hooks/useNewParam.test.tsx`
- Modify: `src/pages/HostsPage.tsx` (host, group), `src/pages/SnippetsPage.tsx` (snippet), `src/components/keys/lists/KeyList.tsx` (key → `generateModal.show`), `src/components/terminal/panes/Pane.tsx`, `src/lib/terminal/paletteCommand.ts`, `CommandPalette.tsx`

**Interfaces:**
- Produces: `useNewParam(handlers: Partial<Record<"host" | "group" | "snippet" | "key", () => void>>): void`; `openPortForwarding(paneId: string): void`, `onOpenPortForwarding(handler: (paneId: string) => void): () => void` in `paletteCommand.ts`.

- [ ] **Step 1: Failing tests**
  - `useNewParam.test.tsx` (MemoryRouter): at `/hosts?new=host` with `{ host }` → `host` called once and the URL search becomes empty (replace); `?new=key` with `{ host }` only → nothing called, param kept.
  - `CommandPalette.test.tsx`: active tab's active pane `{ connectionType: "ssh", hostId: "h1", connectionStatus: "connected" }` in context terminal → "Port forwarding" listed; Enter → `onOpenPortForwarding` handler receives the pane id; local or disconnected pane → not listed.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useNewParam.test.tsx src/components/layout/palette` — Expected: FAIL.
- [ ] **Step 3: Implement.** Pages call `useNewParam` with their existing open functions (`openPanel({ kind: "host" })`, `openPanel({ kind: "group", parentId: null })`, the snippet form's `onNew` body, `generateModal.show`). Pane: effect `onOpenPortForwarding((id) => id === pane.id && setShowPortForwarding(true))`. Palette derives `portForwardingPaneId` from the terminal store when it opens.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — Expected: PASS / clean. `npx biome check <changed files>` clean.
- [ ] **Step 5: Commit** `feat(palette): create actions and port forwarding`
