# Broadcast input — short design

**Intent.** Type once, run on several servers: split a tab across hosts and send the same keystrokes to all of them (Termius/termoso "broadcast"). Second piece of the terminal-productivity phase.

**Design (approved, scope: all panes in the tab).**
- Per-tab toggle **"Broadcast input"**: shortcut `ctrl+shift+b` / `shift+meta+b` (rebindable), and a right-click menu item "Broadcast Input" (shows "✓ Broadcast Input" when on).
- While on, input from the pane you type in (keys, paste, palette snippets: everything through xterm `onData`) is also sent to every other **connected** pane in the same tab. Disconnected/reconnecting panes are skipped.
- Every pane of a broadcasting tab gets an amber outline and a "Broadcasting" badge; the tab shows a broadcast icon.
- Off by default; not persisted across app restarts.

**Approach.** Each session keeps its own `send` function (SSH `send_input` or local `send_input_local`); `onData` sends to itself and, when its tab broadcasts, to the other connected panes found in the tab tree. Rejected: backend fan-out (needs new Rust commands; frontend already knows the panes).

**Non-goals.** Broadcasting across tabs, leaving single panes out.
