# Reopen tabs on relaunch — short design

**Intent.** Closing Shetu loses every open tab and split. Bring them back on the next launch, connected, like Termius's session restore. Third piece of the terminal-productivity phase.

**Design (approved: reconnect automatically).**
- Shetu saves the open layout (tabs, split tree, host per pane, local shell, titles, active tab, active workspace) whenever it changes, debounced 500 ms, to a local plugin-store file `session.json`, keyed by account id. No secrets: only host ids/names, like a saved workspace.
- On launch, after unlock and the current vault's hosts are loaded, if no tabs are open and a saved layout exists, it is reopened through the existing `launchWorkspace` path (so panes connect on their own, deleted hosts show "Missing host", the active workspace stays linked) and the previously active tab is selected again.
- Logout clears the file. Locking keeps it.
- No setting (decided: always on).

**Approach.** Reuse `serializeWorkspaceLayout` / `launchWorkspace`. Rejected: saving to the synced DB (layout is per device), restoring disconnected (user chose auto-reconnect).

**Non-goals.** Restoring scrollback, SFTP/editor tabs, per-vault layouts (panes from another vault show "Missing host").
