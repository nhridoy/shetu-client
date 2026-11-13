import { copySelection, pasteClipboard } from "./terminalContextMenu";

/**
 * xterm key hook for Linux/Windows: Ctrl+Shift+C/V copy and paste, and Ctrl+\ stays the
 * split shortcut instead of also sending the shell its quit signal. macOS needs none of
 * this: Cmd keys go through the Edit menu and never reach the shell.
 * Returns false to stop xterm handling the key; the app's own shortcuts still see it.
 */
export function handleTerminalKey(
  e: KeyboardEvent,
  term: Parameters<typeof copySelection>[0],
  mac: boolean,
): boolean {
  if (mac || !e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.code === "Backslash") return e.shiftKey;
  if (!e.shiftKey) return true;
  const action =
    e.code === "KeyC"
      ? copySelection
      : e.code === "KeyV"
        ? pasteClipboard
        : null;
  if (!action) return true;
  // Stops the webview's own paste so the text isn't pasted twice.
  e.preventDefault();
  if (e.type === "keydown") action(term);
  return false;
}
