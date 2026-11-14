# Side Panel Section Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the host/group side panel into titled section cards (Termius-like), using the app's existing card look, with no behaviour changes.

**Architecture:** Replace the sticky `SidePanel.Section` heading with a `SidePanel.Card` that takes an icon, a title and an optional summary. Regroup the fields in HostForm and GroupForm into the sections from the spec. The summaries are computed from form values and inherited defaults.

**Tech Stack:** React 19, Tailwind v4, phosphor icons, react-hook-form, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-side-panel-section-cards-design.md` (and its parent `2026-11-14-host-group-panel-ui-design.md`).

**Repo / branch:** `/home/nahidujjaman-hridoy/orca/workspaces/client/dogfish`, branch `feat/group-credentials` (HEAD after this plan's commit).

## Global Constraints

- **Card styling:** `bg-dark-800 rounded-lg border border-dark-700/60 p-3`, cards spaced (`space-y-3` or `gap-3`) on the panel background.
  - Header: icon + title in `text-sm font-medium text-white`, and an optional right-aligned summary in `text-xs text-dark-400`.
  - Icon weight and size match AppSidebar/Settings usage.
- **Sections and order:**
  - Host: Address, General, Credentials, Connection, On connect, Environment.
  - Group: General, Credentials, Connection, On connect, Environment.
  - Field placement is per the spec table: jump host goes in Connection on hosts; group General holds only the name.
- **Summaries (exact):**
  - Credentials, Connection and On connect: "from {group}" when that section's From-group value is supplied by a group.
  - Environment: "{n} vars" (host + visible inherited rows); omitted when 0.
- The sticky uppercase headings are removed. The panel header and footer stay pinned. The group intro line stays above the cards.
- **No behaviour change:** validation, submit mapping, hints, discard guard, focus/Esc and inheritance stay as they are. Existing behaviour tests stay green; only section-placement queries may change.
- **Checks:** `bunx vitest run`, `bunx tsc --noEmit`, `bunx biome check <changed files>` (never `--write` on folders). No AI attribution.

## Review Focus

1. **A section with nothing inherited shows no summary.** It never shows "from undefined". Pinned by the Task 1 test `summaries only when inherited`.
2. **The Environment count includes visible inherited rows only:** an overridden inherited row isn't counted twice. Pinned by the Task 1 test `env count`.
3. **Jump host moved to Connection keeps its help text, error and validation.** Pinned by the existing HostForm route tests, which must still pass.

---

### Task 1: Section cards in the side panel

**Files:**
- Modify: `src/components/common/SidePanel.tsx` (replace `Section` with `Card`, or add `Card` and remove the now-unused `Section`).
- Modify: `src/components/hosts/forms/HostForm.tsx`, `src/components/hosts/forms/GroupForm.tsx`, `src/components/hosts/forms/ConnectionOptionsFields.tsx`, `src/components/hosts/forms/CredentialsFields.tsx`, as needed to split fields across cards.
- Tests: `SidePanel.test.tsx`, `HostForm.test.tsx`, `GroupForm.test.tsx`.

**Interfaces:**
- Produces: `SidePanel.Card` props `{ icon: ReactNode; title: string; summary?: string; children: ReactNode }`. It renders a region whose accessible name is the title, as a `section` with `aria-labelledby`.
- `ConnectionOptionsFields` may need to render its parts separately (Connection: keepalive + forwarding; On connect: startup; Environment: env table). Expose this either as a `part` prop or as three small exported components. Keep it DRY.

- [ ] **Step 1: Write failing tests:**
  - `host panel shows cards in order`: region names are exactly Address, General, Credentials, Connection, On connect, Environment.
  - `group panel shows cards in order`: General, Credentials, Connection, On connect, Environment.
  - `jump host is in Connection`: the "Connect through" select is inside the Connection region.
  - `summaries only when inherited`:
    - a host in group "prod" with inherited auth shows "from prod" on Credentials;
    - a host with its own password shows no Credentials summary;
    - no group means no summaries.
  - `env count`: 1 inherited + 1 host row of a different name → "2 vars"; overriding the inherited one → "1 vars"; no rows → no summary.
  - SidePanel: `Card renders labelled region with summary`.
- [ ] **Step 2: Run** `bunx vitest run src/components/common src/components/hosts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bunx vitest run`, `bunx tsc --noEmit`, biome on changed files — Expected: all pass.
- [ ] **Step 5: Commit** `feat(hosts): group the side panel into titled section cards`
