# Run snippets from the command palette — design (short)

Date: 2026-11-13 · Size: small change · Status: draft for approval

## Intent

The terminal's command palette (Ctrl+Shift+P / Cmd+Shift+P, `CommandAutocomplete`) already
lists snippets and a few built-in commands, but picking one does nothing
(`TerminalView.handleCommandSelect` only logs it). Make picking work: the command goes into
the active terminal pane. Roadmap item "run snippets straight from the command palette".

## Decided

- **Enter** (or a click) inserts the command at the prompt without running it.
  **Ctrl+Enter** (Cmd+Enter on macOS) inserts and runs it.
- Built-in commands stay, listed below the user's snippets; they insert/run the same way.

## Approaches

1. **Paste through the pane's terminal (chosen).** Decrypt only the picked snippet
   (`getDecryptedSnippet(id)`), then `xterm.paste(command)` on the active pane's session
   (`getSession(activePaneId)`). It reuses the existing input path (`send_input` for SSH,
   `send_input_local` for local shells) and bracketed paste, so multi-line snippets don't run
   line by line. For "run", send Enter (`\r`) through the same input path afterwards.
2. Call `send_input` / `send_input_local` directly — needs to know the session kind and skips
   paste handling. Rejected.
3. Decrypt every snippet when the palette opens to search command text — keeps all commands
   decrypted in memory for little gain. Rejected; search uses plaintext fields.

## Behaviour

- Search matches a snippet's **name, description and tags** (case-insensitive); built-ins
  match name or command, as today.
- Trailing newlines in a snippet's command are trimmed before pasting (so "insert" never runs
  it by accident).
- After inserting, the palette closes and focus returns to the terminal pane.
- Palette footer hint: "Enter to insert · Ctrl+Enter to run" (Cmd on macOS).
- Failure cases show a toast and keep the palette open:
  - no active terminal pane / session → "Open a terminal first";
  - the snippet can't be decrypted → "Couldn't load this snippet".

## Non-goals

- Snippet variables/placeholders, running a snippet on several panes at once, palette access
  outside the terminal view, editing snippets from the palette.

## Tests

- Palette: Enter calls `onSelect` with run = false; Ctrl/Cmd+Enter with run = true; clicking
  inserts; search by tag finds a snippet; footer hint shown.
- Insert helper (session layer): pastes the trimmed command into the pane's terminal; with run
  it also sends Enter; returns false (no throw) when the pane has no session.
- TerminalView handler: snippet picks are decrypted before inserting; decrypt failure and
  missing pane show the toasts.

## Calls made without asking

- Search by name/description/tags only (command text is encrypted in the list).
- Trailing newlines trimmed; multi-line snippets are pasted as one block.
- Failures keep the palette open with a toast.
