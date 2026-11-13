# Customizable keyboard shortcuts — design

## Intent

Power users expect to rebind an app's shortcuts (Termius and similar apps allow it). Shetu has a
Keyboard Shortcuts screen, but nothing opens it, edits there are lost when it closes, and every
shortcut is hard-coded in the handler that uses it. This makes every shortcut the app defines
itself changeable, saved, and applied immediately.

Success: a user opens Settings → Keyboard, presses a new combination for any of the app's own
shortcuts, and from then on that combination does the action everywhere the shortcut works today
(including the macOS menu bar and the labels in right-click menus), across restarts.

## Goals

- Every shortcut the app defines itself is changeable (list below, grouped by context).
- A **Keyboard** tab in Settings, next to Appearance / Terminal / SSH / Security / Advanced. It
  replaces the orphaned `KeyboardSettings` modal, restyled to match the other tabs.
- Change a shortcut by clicking it and **pressing** the new combination (recording), not typing text.
- A shortcut may be **empty** (no key).
- **Conflicts** are flagged within a context (see Contexts). Two actions never fire for one key.
- **App shortcuts never reach the shell.** Every key bound in App-wide or Terminal view is held
  back from the terminal, so the shortcut works while the terminal has focus.
- **Shell-key warning**: binding a key the shell uses (on Linux/Windows: plain Ctrl+letter, e.g.
  Ctrl+R history search, or Alt+letter) in App-wide or Terminal view shows a warning that the
  terminal won't receive it; the binding still saves.
- **No bare keys where typing happens**: in contexts that fire while typing (App-wide, Terminal
  view, editor Quick open) the recorder refuses a binding without Ctrl/Cmd/Alt; F-keys are allowed.
- **Reset** one shortcut, or all of them, to the default.
- Changes are **saved on this device** in the existing `settings.json` store and take effect
  immediately, without a restart.
- **macOS menu bar** accelerators (New Tab, Close Tab, Quick Connect, Settings) follow the user's
  bindings.
- Right-click menu **labels** (terminal menu, file browser menu, editor explorer menu) show the
  current binding, not a hard-coded string.

## Non-goals

- The code editor's built-in editing keys (CodeMirror `basicSetup`: undo, find, comment line, …).
  They stay standard.
- Navigation keys inside widgets: Enter / Escape / arrows in lists, dialogs, menus, the palette,
  inline rename boxes.
- Focus mode (full-window terminal) and Toggle sidebar: removed by the user after review — the
  sidebar toggle did nothing, and Focus mode's Esc exit couldn't work from a focused terminal.
- Syncing bindings across devices; import/export of bindings; multi-key sequences (Ctrl+K Ctrl+S).
- "Save workspace" (listed today as Ctrl+S but does nothing): removed from the list until it exists.

## Anti-goals

- A binding change that makes one key fire two actions.
- App shortcuts leaking into the shell (today's Ctrl+\ bug, generalized).
- Losing working shortcuts when `settings.json` is missing, corrupt, or has an unknown id:
  defaults must apply.
- Changing default keys beyond the ones listed under Defaults.
- A shortcut that today is ignored while typing in a text box starting to fire there, or vice versa.

## Constraints

- Matching library: **`react-hotkeys-hook` pinned exactly to `5.3.3`** (5.4.0 is under two weeks
  old). Chosen by the user.
- The library matches the **physical key** (`event.code`) by default; keep that (`useKey: false`)
  so bindings work on any keyboard layout. Its `mod` modifier means Cmd on macOS, Ctrl elsewhere.
- By default the library ignores keys while an `input`/`textarea`/`select` is focused. The
  terminal's xterm input **is a textarea**, so every shortcut that must work while the terminal has
  focus needs `enableOnFormTags`.
- macOS menu accelerators are set in Rust (`src-tauri/src/menu.rs`); keys the menu owns must not
  also fire in-app (`isMenuOwnedShortcut`/`hasMacMenu` in `src/lib/window/menuActions.ts`).
- xterm's custom key handler (`src/lib/terminal/terminalKeys.ts`) decides what reaches the shell.
- Editor save is a CodeMirror keymap (`Mod-s` in `EditorView.tsx`); its key syntax differs from the
  library's and must be converted and re-applied when the binding changes.
- Tests: vitest + happy-dom, test-first. Biome lint and `tsc` must stay clean.

## Contexts

A context is where a shortcut is live. Conflicts are checked only inside one context; a view
context may reuse an app-wide key, and the view's binding wins while that view is active (the
Keyboard tab shows "overrides <App-wide action> here").

| Context | Shortcuts (default on Linux/Windows; `mod` = Cmd on macOS) | Focus rule today |
|---|---|---|
| Context | Shortcuts — default as **Linux/Windows · macOS** | Focus rule |
|---|---|---|
| **App-wide** | Quick Connect `ctrl+shift+k` · `meta+k`; Settings `ctrl+comma` · `meta+comma`; Search hosts `/` (hosts page) | Quick Connect, Settings: anywhere, including the terminal. `/`: not while typing. |
| **Terminal view** | New tab `ctrl+shift+t` · `meta+t`; Close pane `ctrl+shift+w` · `meta+w`; Next tab `ctrl+tab` · `meta+tab`; Previous tab `ctrl+shift+tab` · `meta+shift+tab`; Split right `ctrl+backslash` · `meta+backslash`; Split down `ctrl+shift+backslash` · `meta+shift+backslash`; Snippets palette `ctrl+shift+p` · `meta+shift+p`; Copy `ctrl+shift+c` · —*; Paste `ctrl+shift+v` · —* | Anywhere, including the terminal; never reach the shell. |
| **File browser** | Copy `mod+c`; Cut `mod+x`; Paste `mod+v`; New file `mod+n`; New folder `mod+shift+n`; Select all `mod+a`; Rename `f2`; Refresh `f5`; Delete `delete`; Up a folder `backspace` | Not while typing. Rename/Delete need a selection. |
| **Editor** | Quick open `mod+p`; Toggle file list `mod+b`; Save `mod+s`; Copy path `mod+c` (explorer); Rename `f2`; Delete `delete` | Quick open: anywhere. Toggle: not while typing. Save: in the editor. Copy path/Rename/Delete: in the explorer. |

\* Terminal copy/paste stay Linux/Windows-only by default; on macOS Cmd+C/V go through the Edit
menu and are shown, not rebindable (the menu's Copy/Paste are system items).

Today, on Linux/Windows, xterm sends plain Ctrl+letter keys to the shell and stops the event
(`cancel` → `stopPropagation` in `CoreBrowserTerminal.ts`), so Ctrl+T/W/Tab/B never reach the
app while the terminal has focus. The new Linux/Windows defaults (chosen by the user) use
Ctrl+Shift like GNOME Terminal and Windows Terminal, so every App-wide and Terminal-view shortcut
works from the terminal and Ctrl+T/W/B/K stay with bash, readline and tmux.

File browser and editor shortcuts keep the focus rules they have today.

On macOS the four menu-bar shortcuts (New tab, Close pane, Quick Connect, Settings) fire from every
page, so for conflict checks they count as App-wide there.

## Approaches considered

- **A. Own small matcher** — a ~40-line `matches(event, id)` called by each existing handler.
  Least change, no dependency.
- **B. `react-hotkeys-hook` (chosen by the user)** — the library does matching (scopes, dynamic
  keys, a key recorder `useRecordHotkeys`); each area's handler is rewritten as `useHotkeys` calls.
  Recording UI, conflicts, labels, persistence, macOS menu, terminal and editor integration are
  still ours.
- **C. One central dispatcher owning all key handling** — rejected: a rewrite of working code with
  the most risk.

## Design

1. **Registry** (`src/lib/shortcuts/`): one list of shortcut definitions — id, context, label,
   default binding in the library's syntax, focus rule. The single source for the Keyboard tab,
   handlers, menu labels, the macOS menu and the terminal key filter.
2. **Bindings store**: user overrides only (`id → binding | ""`), persisted under a `shortcuts`
   key in `settings.json` via the existing settings store pattern. Effective binding = override ??
   default. Unknown ids and invalid strings are ignored on load.
3. **Handlers**: each area replaces its hard-coded checks with library hooks reading the effective
   binding (a thin `useShortcut(id, callback)` wrapper is the builder's call), keeping each focus
   rule above. `src/hooks/useKeyboardShortcuts.ts`, `src/hooks/sftp/useFileKeyboardShortcuts.ts`,
   `EditorLayout.tsx`, `EditorExplorer.tsx`, `QuickConnect.tsx`, `HostsPanel.tsx`, `Layout.tsx`
   (Settings) are the call sites. On macOS, ids owned by the menu bar don't fire in-app.
4. **Terminal**: `handleTerminalKey` holds back from the shell any key bound in App-wide or
   Terminal view (replacing the hard-coded Ctrl+\ rule), and runs terminal copy/paste from their
   bindings.
5. **Editor save**: the CodeMirror keymap is built from the Save binding (converted to CodeMirror
   syntax) and reconfigured when it changes.
6. **macOS menu**: a Tauri command updates the four menu items' accelerators from the bindings at
   startup and on change; an empty binding removes the accelerator.
7. **Keyboard tab**: grouped by context; each row shows the label and the binding as a key cap
   (macOS symbols ⌘ ⇧ ⌥ ⌃; elsewhere `Ctrl+Shift+P`). Click → recording ("Press keys…", Escape
   cancels); a conflict shows "Already used by <action>" with **Replace** (clears the other) or
   **Cancel**; a shell-key warning shows under the row; per-row reset when changed, "Reset all"
   in the footer, and a clear (empty) action.
8. **Labels**: `terminalContextMenu.ts`, the SFTP context menu and `explorerMenu.ts` read the
   effective binding for their `shortcut` text.

## Defaults

macOS: unchanged. Linux/Windows, chosen by the user: New tab Ctrl+Shift+T (was Ctrl+T), Close pane
Ctrl+Shift+W (was Ctrl+W). Designer's calls: Quick Connect
Ctrl+Shift+K (was Ctrl+K, which is the shell's delete-to-end-of-line); Settings gains Ctrl+, (today
only on macOS). "Save workspace" is removed. Saved user bindings are never changed by these new
defaults (there are none yet).

## Calls made by the designer (check these)

- Conflict resolution offers Replace/Cancel rather than blocking outright.
- Terminal copy/paste on macOS are shown but not rebindable (system Edit-menu items).
- Settings gains Ctrl+, on Linux/Windows.
- Quick Connect moves to Ctrl+Shift+K on Linux/Windows, so the shell keeps Ctrl+K.
- On macOS the menu-bar shortcuts count as App-wide for conflicts.
- In contexts that fire while typing, bindings need Ctrl/Cmd/Alt (F-keys excepted); the shell-key
  warning also covers Alt+letter.
- Editor explorer Copy path (`mod+c`) is included.
- The file browser accepts only `mod` (Cmd on macOS); today it also accepts Ctrl on a Mac.

## Left to the builder

File and function names; whether to use library scopes or per-hook `enabled` to switch contexts;
the binding string ↔ display ↔ CodeMirror conversions; how the macOS menu update is exposed from
Rust; the exact layout of the Keyboard tab within the existing Settings style.
