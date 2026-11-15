# Terminal search — short design

**Intent.** Find text in a terminal's scrollback, like Termius/termoso's find bar. First piece of the "terminal productivity" phase (order agreed: search → multi-pane typing → reopen on relaunch → snippet variables/bulk run → forward auto-start → app-wide palette).

**Design (approved).**
- New rebindable shortcut **"Find in terminal"**: `ctrl+shift+f` (Linux/Windows), `meta+f` (macOS). Plain Ctrl+F stays with the shell. Also a **"Find…"** item in the terminal right-click menu.
- A find bar floats top-right over the focused pane: query input, "N of M" / "No results", ↑ ↓ buttons, toggles **Aa** (match case), **W** (whole word), **.\*** (regex), ✕.
- Live search while typing; all matches highlighted, the current one emphasised. Enter / ↓ = next, Shift+Enter / ↑ = previous. Invalid regex shows "Invalid pattern".
- Esc or ✕ closes, clears highlights, focuses the terminal. Reopening keeps the last query.

**Approach.** `@xterm/addon-search` 0.16.0 (official, xterm 6 generation) loaded per session; decorations need `allowProposedApi: true`. Rejected: hand-rolled buffer scanning (much more code, same result).

**Non-goals.** Searching all panes at once, replace.
