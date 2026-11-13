import { matchesBinding } from "@/lib/shortcuts/binding";
import {
  effectiveBinding,
  isHeldBackFromTerminal,
} from "@/stores/shortcuts/shortcutStore";
import { copySelection, pasteClipboard } from "./terminalContextMenu";

/**
 * xterm key hook. Runs terminal copy/paste on their bindings, and keeps every app shortcut
 * from reaching the shell so it works while the terminal has focus.
 * Returns false to stop xterm handling the key; the app's own shortcuts still see it.
 */
export function handleTerminalKey(
  e: KeyboardEvent,
  term: Parameters<typeof copySelection>[0],
  mac: boolean,
): boolean {
  const action = matchesBinding(
    e,
    effectiveBinding("terminal.copy", undefined, mac),
  )
    ? copySelection
    : matchesBinding(e, effectiveBinding("terminal.paste", undefined, mac))
      ? pasteClipboard
      : null;
  if (action) {
    // Stops the webview's own paste so the text isn't pasted twice.
    e.preventDefault();
    if (e.type === "keydown") action(term);
    return false;
  }
  return !isHeldBackFromTerminal(e, mac);
}
