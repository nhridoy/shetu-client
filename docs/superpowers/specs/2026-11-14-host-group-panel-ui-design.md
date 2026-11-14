# Host and group editing in a side panel — UI design

This follows up group credentials (PR #33). The user said the new host and group forms "look
like shit", and chose to move editing into a side panel in the Termius style.

## Intent

The host and group forms grew Credentials and Connection sections inside a narrow 448px modal.
Today:
- the auth choices squeeze 5–6 buttons into one row;
- full-width grey "Advanced" and "Credentials" buttons toggle sections;
- inherited values are faint grey text;
- every env row repeats its labels;
- help text shows literal backticks.

Success: editing a host or group feels like Termius. It happens in a tidy panel next to the list,
inherited values are obvious and easy to override, and nothing is cramped.

## Goals

**Panel (user's choice: side panel that pushes the list).**
- Opening "New host", "Edit host", "New group" or "Edit group" shows a full-height panel on the
  right of the hosts page, about **420px** wide. The host list shrinks and stays usable.
- On windows narrower than **900px**, the panel overlays the list instead, with a dimmed backdrop.
- Header: the title ("New host", "Edit host · {name}", "New group", "Edit group · {name}") and a
  close ✕.
- Body: scrolls, with **sticky section headings**: GENERAL, CREDENTIALS, CONNECTION.
- Footer: pinned **Cancel** and **Save**.
- **Esc** or ✕ closes it. With unsaved changes it first asks "Discard changes?", using the
  existing ConfirmDialog.
- Clicking another host in the list while editing switches the panel to that host, asking the
  same question if there are unsaved changes.
- Only one panel is open at a time. It replaces the host and group modals; the ssh_config import
  modal is unchanged.

**Sections.**
- **Host, GENERAL:** Name; Address + Port on one row; Group; "Connect through" (jump host) with
  its help; Color swatches; Tags.
- **Host, CREDENTIALS:** Username and Login method.
- **Host, CONNECTION:** Keepalive, On connect, Forward SSH agent, Environment variables.
- **Group:** GENERAL (Name) plus the same CREDENTIALS and CONNECTION sections, with no "From group"
  choices. One intro line: "Hosts in this group use these unless they set their own."
- Sections are always expanded; the sticky headings replace the "Advanced" and "Credentials"
  toggle buttons.

**Inherited values are visible and easy to override (host).**
- **Username:**
  - When the group provides one and the host doesn't set its own, the field shows the group's
    value as a greyed placeholder with a small badge naming the group ("prod").
  - Typing overrides it.
  - When the host has its own value and the group also has one, a ↺ "Use group value" button
    clears the field.
- **Login method:** a single dropdown (Select) replaces the row of buttons.
  - Host options: From group (only when the host has a group), Password, SSH key, Password + key,
    None.
  - Group options: Not set, Password, SSH key, Password + key, None.
  - With From group, a line under it shows what it resolves to, e.g. "Password · prod" or
    "SSH key 'deploy-key' · prod". With nothing inherited it says "No group sets a login — uses
    agent/none".
  - Password and key fields appear only when the method needs them.
- **Keepalive, On connect, Forward SSH agent:**
  - Each is a dropdown with "From group" first (host). The line under it shows the resolved value:
    "30s · prod", "Off · default", "runs a command · prod", "snippet · prod", "Off".
  - Values come from the existing `inherited_host_defaults` fields: `keepaliveSecs`,
    `keepaliveFrom`, `startupKind`, `startupFrom`, `forwardAgent`, `forwardAgentFrom`.
  - The command text isn't shown, because the command isn't returned. Keep it that way.
- **Environment variables:** a compact table with one header row (Name | Value | blank column for
  the delete action).
  - Inherited rows show greyed, with the group badge and an **Override** action that adds an
    editable row with the same name.
  - A host row that overrides a name hides the inherited row and shows "overrides prod" on the
    host row.
  - Editable rows have inline inputs with no repeated labels, and a trash-icon button with an
    aria-label.
  - Below the table: "+ Add variable".
  - Help text, with `AcceptEnv` rendered as `<code>`: "Servers ignore variables they don't allow
    (AcceptEnv in sshd_config); most allow only LANG and LC_*."

**Look.**
- Use the existing UI kit:
  - `FormInput`, `FormSelect`, `Textarea` and `Badge` from `components/ui`;
  - `Button` variants, including `size="icon-xs"` for icon buttons;
  - phosphor icons.
- Use the app's dark palette and spacing. No new dependencies.
- Section headings: small uppercase, muted, with a hairline divider. These are sticky within the
  panel body.

## Non-goals

- Changing what's saved or how inheritance resolves. This is purely presentation. Store, schema
  and Rust behaviour stay as merged in PR #33, apart from what the UI needs.
- Redesigning the hosts list, host cards, the keys page, the ssh_config import modal or settings.
- Showing a group's startup command text or any password.

## Anti-goals

- Losing unsaved edits silently, whether through Esc, ✕, switching hosts or switching to another
  page.
- A regression in any existing form behaviour or test:
  - validation messages;
  - new-host defaults;
  - consent recording;
  - the group-form load guard;
  - inherited placeholders;
  - "No Group" saving null.
- Inaccessible controls: every input keeps a label, which can be visually hidden in the env table;
  icon buttons have aria-labels; focus moves into the panel on open and returns on close.

## Constraints

- React 19 + Tailwind + the house UI components. Forms use react-hook-form + zod; reuse the
  existing schemas and submit mapping.
- HostForm and GroupForm currently render inside `ModalForm` (src/components/common/ModalForm.tsx).
  The panel replaces that wrapper for these two forms only.
- HostsPage (src/pages/HostsPage.tsx) currently opens forms with `useModal`. It becomes a
  two-column layout while a panel is open.
- The existing component tests (HostForm.test.tsx, GroupForm.test.tsx) must keep passing,
  updated only where they query removed toggle buttons.
- No AI attribution.

## Approaches considered

- Tabs in a wider modal; one page of section cards; **side panel (chosen by the user)**.
- For the panel: **pushing the list (chosen by the user)**, or overlaying it as a drawer.

## Calls made after the builder check (designer's calls — flagged for review)

1. **Leaving the Hosts page with unsaved edits.**
   - The open panel publishes a "dirty" flag in a tiny shared store.
   - The app's in-app navigation (sidebar and tab switches in `Layout.tsx`) checks it and asks
     "Discard changes?" before navigating.
   - A `beforeunload` handler covers closing or reloading the window.
   - No router migration: the app uses `BrowserRouter`, and `useBlocker` needs a data router.
2. **"Unsaved changes"** means react-hook-form's `isDirty`, measured against the values the panel
   finished loading. Async loads and inherited-value updates `reset` the baseline, so they never
   count. Opening "New host" and pressing Esc without typing closes silently.
   - The prompt fires on any switch while dirty: another host, group, "New host" or "New group".
3. **Esc and focus.**
   - Esc closes the panel only when focus is inside it and no dropdown or dialog inside it is open.
     Open Selects and the ConfirmDialog handle their own Esc first.
   - In push mode the panel is not modal and doesn't trap focus. In overlay mode (narrow) it traps
     focus and the backdrop closes it, with the same dirty check.
   - Focus moves to the first field on open, and returns to the element that opened the panel when
     it closes.
4. **Layout.**
   - The hosts page becomes a flex row inside the existing content area: the list scrolls on its
     own, and the panel is full height with its own scrolling body.
   - The 900px breakpoint is measured on the **hosts page's own width** (container width, through
     a ResizeObserver or a CSS container query), not the window. Sidebars therefore count
     correctly.
5. **Inheritance details in the panel.**
   - Inherited values reflect the Group currently selected **in the panel**, re-fetched when it
     changes. Keep the existing stale-response guard and the "clear inherited values on group
     change" behaviour from commit 76a5ecd.
   - ↺ "Use group value" appears only while the selected group provides a username and the host
     has its own.
   - Env **Override** adds a host row prefilled with the inherited name and value. Deleting that
     row brings the inherited row back.
6. **Group GENERAL** keeps whatever parent-group handling exists today: the `defaultParentId` for
   "New group" and the current parent kept on edit. It gains no new parent picker.

## Left to the builder

- Exact widths, spacing and transition, within the app's style.
- Whether the panel is a new `components/common/SidePanel.tsx`, recommended because both forms
  use it, or local to the hosts feature.
