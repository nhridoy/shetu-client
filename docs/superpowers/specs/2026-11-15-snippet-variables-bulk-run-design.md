# Snippet variables and bulk run — design

**Intent.** Run a saved command across many servers the way Termius does, and make snippets reusable with placeholders. Fourth piece of the terminal-productivity phase.

**Termius reference (docs.termius.com/terminal/snippets).** Running a snippet from the Snippets screen "creates new connections to the selected hosts" in a workspace, one tab per host; "Save targets" stores the selected hosts in the snippet; "Run in all tabs" runs it in all active terminals. No headless run or results panel. Termius has no snippet variables ("not supported yet"); Shetu adds them (user decision).

**Design (approved).**
1. **Variables.** `{{name}}` (name: letter or `_`, then letters, digits, `_`, `-`; spaces inside the braces allowed) marks a variable. Using a snippet with variables (palette insert/run, Run on hosts, Run in all tabs) opens a form, one field per unique name, prefilled with the last values used this session (memory only). Enter continues, Esc cancels and nothing is sent. Snippets without variables are unchanged.
2. **Run on hosts.** Snippets list rows get a ▶ "Run on hosts" button → dialog listing the current vault's hosts (search, checkboxes) preselected with the snippet's saved targets. "Save targets" stores the selection in the snippet's encrypted payload (`targets: string[]`). "Run" fills variables once, opens one new tab per host, sends the command (and Enter) as soon as each pane connects, and goes to the terminal view.
3. **Run in all tabs.** In the terminal snippet palette, Ctrl+Shift+Enter (⇧⌘↵) runs the picked snippet in every connected pane of every tab; a toast says how many. Footer hint updated.

**Calls (designer).** Variable values are the same for all hosts in one run. Panes that fail or are closed before connecting just don't get the command (stop waiting after 2 minutes). Run in all tabs skips disconnected panes. No confirmation dialog (explicit key / button).

**Non-goals.** Headless execution, results panel, default values (`{{x=1}}`), saving runs as workspaces.
