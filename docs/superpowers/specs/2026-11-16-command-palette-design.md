# App-wide command palette — design (short)

Date: 2026-11-16 · Size: small project · Status: draft for approval

## Intent

Termius/termoso have one ⌘K palette for hosts and actions. Shetu has two narrower panels:
Quick Connect (hosts + local shells, any view) and the Snippets palette (terminal only).
Gap analysis row "Command palette: terminal-scoped snippets only → global actions + hosts".
Goal: one searchable place to connect, run a snippet, jump to a page, or trigger any action.

## Decided (by the user)

- **One palette.** Quick Connect grows into it: hosts, local shells, snippets, actions.
  Opened with the Quick Connect binding (Ctrl+Shift+K / ⌘K). Ctrl+Shift+P / ⇧⌘P (terminal)
  opens the same palette filtered to snippets. The separate `CommandAutocomplete` goes away.
- **Snippet pick.** In the terminal view: Enter inserts, Ctrl/⌘+Enter runs (as today,
  `{{variables}}` asked first). Anywhere else: Enter opens the existing Run on hosts dialog
  for that snippet.
- **Actions listed:** shortcut actions that make sense in the current view, each showing its
  binding; "Go to" each sidebar page; create actions — New host, New group, New snippet,
  New key, Port forwarding.
- **Approach:** reuse shortcut handlers (below).

## Approaches

1. **Reuse shortcut handlers (chosen).** `useShortcut` also answers a palette request for its
   id (a DOM event, like `dispatchAppAction`), and records which ids have a live handler.
   The palette lists only those, so the list follows the open view and runs exactly what the
   key does.
2. Separate command list calling stores directly — duplicates every shortcut's logic and can
   drift from it. Rejected.
3. Separate actions-only palette / snippets palette made global — rejected by the user in
   favour of one palette.

## Behaviour

- Sections in order: Hosts, Local shells, Snippets, Actions. Empty query shows all sections
  (each capped, e.g. 8 rows); typing filters case-insensitively by substring:
  hosts by name/address, shells by name/path, snippets by name/description/tags (command text
  stays encrypted in list state), actions by label.
- ↑/↓ move across sections, Enter picks, Esc closes. Footer hint follows the selected row
  ("Enter to connect", "Enter to insert · Ctrl+Enter to run", "Enter to run on hosts", …).
- Hosts / shells: connect as Quick Connect does today.
- Snippets in the terminal view also list the current built-in commands; outside it they don't
  (nothing to insert into). Failures keep the palette open with the existing toasts.
- Actions run through their shortcut handler. Ids whose handler isn't mounted are not listed.
  Unbound actions (binding cleared) still run from the palette. On macOS, menu-bar actions
  (`menuItem`) go through `dispatchAppAction`, as the menu does.
- Not listed (they act on a focused selection the palette would steal focus from, or are the
  palette itself): `app.quickConnect`, `terminal.palette`, `terminal.copy`, `terminal.paste`,
  `files.copy/cut/paste/selectAll/rename/delete/up`, `editor.copyPath/rename/delete`.
  Marked in the registry, e.g. `palette: false`.
- Pages: "Go to Hosts / Workspaces / Snippets / Keychain / History / Teams" navigate.
- Create: New host / New group / New snippet / New key navigate to the page with
  `?new=host|group|snippet|key`; the page opens that form and clears the param.
  Port forwarding is listed only when the active terminal pane is a connected SSH host; it
  opens that pane's port-forwarding panel.
- Shortcut label `app.quickConnect` becomes "Command palette"; its id and the macOS menu item
  stay, so custom bindings carry over. `terminal.palette` label stays "Snippets palette".

## Non-goals

Fuzzy ranking, recent/frequent items, workspaces, settings tabs and toggles, editing items from
the palette, actions from views that aren't open.

## Tests

- `useShortcut`: a palette request runs the handler; the live-id set tracks mount/unmount and
  `enabled: false`; an unbound action still runs.
- Palette: sections and filters (host address, snippet tag, action label); actions listed only
  with a live handler and never the `palette: false` ones; Enter on an action runs it and
  closes; Ctrl+Shift+P opens filtered to snippets.
- Snippet pick: terminal view inserts / runs via `pickPaletteItem`; elsewhere opens Run on
  hosts.
- Pages: `?new=host` (and group/snippet/key) opens the form once and clears the param.
- Port forwarding action: listed only for a connected SSH pane; opens its panel.

## Calls made without asking

- Substring search with per-section caps, no ranking.
- `palette: false` exclusion list above.
- `?new=` query param for create actions.
- Port forwarding stays pane-scoped (its UI only exists per pane).
- Component renamed `QuickConnect` → `CommandPalette`.
