# Host/Group Side Panel UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move host and group editing from the narrow modal into a Termius-style side panel that pushes the host list. Show inherited values clearly, and tidy the credentials, connection and env UI.

**Architecture:**
- New pieces: a reusable `SidePanel` (header, scrolling body with sticky section headings, pinned footer, Esc / dirty / focus handling, overlay mode when narrow) and a tiny unsaved-changes store consulted by in-app navigation.
- HostsPage becomes a two-column layout, and HostForm/GroupForm render inside the panel instead of `ModalForm`.
- The shared `CredentialsFields` / `ConnectionOptionsFields` get the new controls and inherited hints.

**Tech Stack:** React 19, Tailwind, react-hook-form + zod, zustand, phosphor icons, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-14-host-group-panel-ui-design.md` (read "Calls made after the builder check").

**Repo / branch:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/group-credentials` (PR #33, HEAD 46cbfc1).

## Global Constraints

- **Presentation only.** Don't change saved data shapes, schemas' saved values, the submit mapping or Rust.
- These behaviours from PR #33 must survive:
  - validation messages;
  - new-host defaults;
  - consent recording rules;
  - the group-form load guard;
  - stale-inherited clearing on group change;
  - "No Group" saves `null`.
- **Panel:** about `420px` wide, full height of the hosts content area; pushes the list. When the **hosts page container** is narrower than `900px`, it overlays with a dimmed backdrop and traps focus.
- **Panel titles:** "New host" / "Edit host · {name}" / "New group" / "Edit group · {name}". Close ✕ has aria-label "Close panel".
- **Section headings (exact, uppercase):** GENERAL, CREDENTIALS, CONNECTION. Sticky within the panel body. Group panel intro (exact): "Hosts in this group use these unless they set their own."
- **Dirty and discard:**
  - Dirty is react-hook-form `isDirty` against the loaded baseline.
  - Confirm dialog title (exact): "Discard changes?"; buttons "Discard" / "Keep editing".
  - It applies to Esc, ✕, switching host/group/new, sidebar navigation away from Hosts, and window close (`beforeunload`).
- **Esc** closes only when focus is inside the panel and no inner dropdown or dialog is open.
- **Focus:** moves to the first field on open and returns to the opener on close.
- **Login method:** a single Select.
  - Host options: "From group" (only with a group, or when the stored value is inherit), "Password", "SSH key", "Password + key", "None".
  - Group options: "Not set", "Password", "SSH key", "Password + key", "None".
- **Resolved-value lines under host "From group" choices (exact formats):**
  - Login: "Password · {group}", "SSH key '{keyName}' · {group}" (or "SSH key · {group}" with no key name), "Password + key · {group}", "None · {group}". With nothing inherited: "No group sets a login — uses agent/none".
  - Keepalive: "{n}s · {group}", "Off · {group}", or "Default" when not inherited.
  - On connect: "runs a command · {group}", "runs a snippet · {group}", or "Nothing" when not inherited.
  - Forward SSH agent: "On · {group}", "Off · {group}", or "Off" when not inherited.
- **Username inheritance:**
  - The placeholder is the group's username, with a `Badge` showing the group name.
  - A ↺ button (aria-label "Use group value") shows only while the selected group provides a username and the host has its own; clicking it clears the field.
- **Env table:**
  - One header row: "Name" / "Value". Inputs keep visually hidden labels "Name {n}" / "Value {n}". The trash icon button has aria-label "Remove variable {n}".
  - Inherited rows are greyed, with a group `Badge` and an "Override" button that adds a host row prefilled with the name and value. Deleting that host row shows the inherited row again.
  - A host row overriding a name shows "overrides {group}".
  - "+ Add variable".
  - Help text: "Servers ignore variables they don't allow (<code>AcceptEnv</code> in sshd_config); most allow only LANG and LC_*."
- **Kit and accessibility:**
  - Use the existing UI kit (`FormInput`, `FormSelect`, `Textarea`, `Badge`, `Button` incl. `size="icon-xs"`, `ConfirmDialog`) and phosphor icons. No new dependencies.
  - Every input keeps an accessible label.
- **Checks:** `bunx vitest run` (no package.json test script), `bunx tsc --noEmit`, `bunx biome check <changed files>` (never `--write` on folders). No AI attribution.

## Review Focus

1. **Opening a host, typing nothing, and closing (Esc/✕) or switching hosts doesn't ask "Discard changes?"**: async load and inherited updates don't count as dirty. Pinned by the Task 2 test `edit host without typing closes without prompt`.
2. **A dirty panel survives an accidental sidebar click:** navigation asks first, and "Keep editing" stays on Hosts with the edits intact. Pinned by the Task 1 test `sidebar navigation asks when dirty`.
3. **Esc inside an open Select closes the Select, not the panel.** Pinned by the Task 1 test `escape in open select keeps panel`.
4. **Every PR #33 form behaviour test still passes** after the move from ModalForm (consent, load guard, stale clear, No Group null). Pinned by the existing HostForm/GroupForm suites running green in Task 2.
5. **Narrow container:** the panel overlays, traps focus, and the backdrop click respects the dirty check. Pinned by the Task 1 test `overlay mode under 900px`.

---

### Task 1: SidePanel + unsaved-changes guard

**Files:**
- Create: `src/components/common/SidePanel.tsx` + `SidePanel.test.tsx`.
- Create: `src/stores/ui/unsavedChangesStore.ts` (+ test).
- Modify: `src/components/layout/shell/AppSidebar.tsx` (nav item clicks) and `src/components/layout/shell/Layout.tsx` (its `navigate(...)` calls): await the guard before navigating.

**Interfaces:**
- Produces:
  - `SidePanel` props: `{ title: string; open: boolean; dirty: boolean; onClose: () => void; footer: ReactNode; children: ReactNode; intro?: string }`.
    - The panel calls `onClose` directly when not dirty. When dirty it shows ConfirmDialog ("Discard changes?", "Discard" / "Keep editing") and calls `onClose` only on Discard.
    - Exposes `<SidePanel.Section title="GENERAL">` for sticky headings.
    - Measures its parent container width with a ResizeObserver to pick push or overlay.
  - `useUnsavedChanges` (zustand):
    - `{ dirty: boolean; setDirty(v: boolean): void; confirmLeave(): Promise<boolean> }`. `confirmLeave` resolves true immediately when clean, otherwise opens the same confirm and resolves with the choice.
    - The store also renders nothing; a small `UnsavedChangesDialog` component mounted once in Layout shows the confirm for `confirmLeave`.
  - `SidePanel` sets the store's `dirty` while open and dirty, clears it on unmount, and registers a `beforeunload` handler while dirty.

- [ ] **Step 1: Write failing tests:**
  - `renders title, sections and footer`.
  - `close without changes calls onClose`.
  - `close with changes asks and Keep editing keeps it open`.
  - `Discard calls onClose`.
  - `escape inside panel closes`.
  - `escape in open select keeps panel`: open a FormSelect inside, press Escape → the select closes and `onClose` isn't called.
  - `escape with focus outside panel does nothing`.
  - `overlay mode under 900px`: mock ResizeObserver width 800 → a backdrop exists, Tab cycles within the panel, and a backdrop click with dirty asks.
  - `focus moves to first field and returns to opener`.
  - Store: `confirmLeave resolves true when clean`.
  - Sidebar: `sidebar navigation asks when dirty`: dirty → click a nav item → dialog shows; Keep editing → `navigate` not called; Discard → `navigate` called.
- [ ] **Step 2: Run** `bunx vitest run src/components/common src/stores/ui src/components/layout` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Panel styling uses the app's dark palette:
    - `bg-dark-900`, `border-l border-dark-700`;
    - header `h-12`;
    - body `overflow-y-auto`;
    - sticky section heading: small uppercase muted text with a hairline divider, `sticky top-0 bg-dark-900 z-10`;
    - footer `border-t`, buttons right-aligned.
  - Use the same transition style as other app panels, if any; otherwise a 150ms slide.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome on the changed files — Expected: pass.
- [ ] **Step 5: Commit** `feat(ui): side panel with unsaved-changes guard`

### Task 2: HostsPage two-column layout; forms in the panel

**Files:**
- Modify: `src/pages/HostsPage.tsx`, `src/components/hosts/forms/HostForm.tsx`, `src/components/hosts/forms/GroupForm.tsx`, and their tests. Possibly `src/components/hosts/panels/HostsPanel.tsx` so the clicked host reports through `onEditHost`, as today.

**Interfaces:**
- Consumes: `SidePanel`, `useUnsavedChanges` (Task 1).
- Produces:
  - HostForm and GroupForm render inside `SidePanel` (title, sections GENERAL / CREDENTIALS / CONNECTION, footer Cancel / Save) instead of `ModalForm`, and pass `dirty={formState.isDirty}`.
  - The "Advanced" / "Credentials" toggle buttons are removed; sections are always visible.
  - HostsPage keeps one `panel` state: `{ kind: "host" | "group"; id?: string; defaultGroupId?; parentId? } | null`. Switching while dirty goes through `useUnsavedChanges.confirmLeave()`.

- [ ] **Step 1: Write failing tests:**
  - HostsPage:
    - `opens host panel beside the list` (list still rendered).
    - `edit host without typing closes without prompt`.
    - `switching to another host while dirty asks`.
    - `New group while editing a host asks when dirty`.
  - Update HostForm/GroupForm tests: open the CREDENTIALS/CONNECTION fields directly (no toggle clicks). All PR #33 behaviour assertions stay.
- [ ] **Step 2: Run** `bunx vitest run src/pages src/components/hosts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The page is a flex row: list `flex-1 min-w-0 overflow-y-auto`; panel at its right.
  - Async loads (`getDecryptedHost`, `getDecryptedGroup`, inherited defaults) `reset` the form baseline so they don't mark it dirty, keeping the existing `keepDirtyValues` behaviour for user edits.
  - GroupForm keeps the intro line and its load guard.
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): edit hosts and groups in a side panel`

### Task 3: Credentials and connection controls with inherited hints

**Files:** Modify `src/components/hosts/forms/CredentialsFields.tsx`, `src/components/hosts/forms/ConnectionOptionsFields.tsx` (except the env block), `src/components/hosts/forms/HostForm.tsx` (username field), and tests.

**Interfaces:**
- Consumes: `InheritedDefaults` (`src/lib/hosts/inherited.ts`).
- Produces: `formatInherited` helpers in `src/lib/hosts/inheritedLabels.ts` returning the exact resolved-value strings from Global Constraints:
  - `loginLine(i?: InheritedDefaults): string`
  - `keepaliveLine(i?): string`
  - `startupLine(i?): string`
  - `forwardLine(i?): string`

- [ ] **Step 1: Write failing tests:**
  - `inheritedLabels.test.ts`: every exact string, including the no-key-name and nothing-inherited cases.
  - Components:
    - The login method is a Select with the exact host/group options.
    - "From group" shows `loginLine` underneath.
    - Password and key fields appear only for their methods.
    - The keepalive / on-connect / forwarding "From group" choices show their lines.
    - The username shows the inherited placeholder and group Badge; ↺ appears only when the host has its own username and the group provides one, and clicking it empties the field.
    - No password text ever renders.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): clearer login and connection controls with inherited values shown`

### Task 4: Environment variables table

**Files:** Modify `src/components/hosts/forms/ConnectionOptionsFields.tsx` (env block) + tests.

**Interfaces:**
- Consumes: `InheritedDefaults.env` (`[{ name, value, from }]`).

- [ ] **Step 1: Write failing tests:**
  - One header row (Name / Value), with no per-row visible labels.
  - Inputs have hidden labels "Name 1" / "Value 1".
  - The trash button has aria-label "Remove variable 1".
  - Inherited rows show greyed with a group Badge and an "Override" button.
  - Override adds a host row prefilled with the inherited name and value, and hides the inherited row; the host row shows "overrides prod".
  - Removing that host row shows the inherited row again.
  - The help text renders `AcceptEnv` inside `<code>`, with no backticks.
  - Invalid-name validation messages are unchanged.
- [ ] **Step 2: Run** the focused tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome — Expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): compact environment variables table with inherited rows`

### Task 5: Visual check

- [ ] Run `bun run tauri dev` and look at, at a wide width and below 900px:
  - New host, Edit host (in a group with credentials), New group and Edit group;
  - discard prompts;
  - Esc;
  - focus.
- [ ] Record the results in the ledger. Anything not checked goes in the PR as untested.
