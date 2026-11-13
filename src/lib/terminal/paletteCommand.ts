/** A command palette entry: a user snippet (decrypted on pick) or a built-in command. */
export type PaletteItem = { snippetId?: string; command: string };

export type PickResult =
  | "ok"
  | "no-pane"
  | "not-connected"
  | "decrypt-failed"
  | "unsafe-multiline"
  | "empty";

/** Puts the picked command into the active pane: inserted, or run when `run`. */
export async function pickPaletteItem(
  item: PaletteItem,
  run: boolean,
  deps: {
    activePaneId: string | null;
    isConnected(paneId: string): boolean;
    decryptSnippet(id: string): Promise<{ command: string } | null>;
    insert(
      paneId: string,
      text: string,
      run: boolean,
    ): "ok" | "no-pane" | "unsafe-multiline" | "empty";
  },
): Promise<PickResult> {
  if (!deps.activePaneId) return "no-pane";
  // Input to a disconnected or exited shell is silently dropped by the backend.
  if (!deps.isConnected(deps.activePaneId)) return "not-connected";
  let command = item.command;
  if (item.snippetId) {
    // Snippet commands are encrypted in list state; decrypt only the one picked.
    const snippet = await deps.decryptSnippet(item.snippetId).catch(() => null);
    if (!snippet) return "decrypt-failed";
    command = snippet.command;
    // The pane may have disconnected while we waited.
    if (!deps.isConnected(deps.activePaneId)) return "not-connected";
  }
  return deps.insert(deps.activePaneId, command, run);
}

const OPEN_PALETTE_EVENT = "shetu:open-command-palette";

/** Asks the terminal view to open the command palette, e.g. from a pane's context menu. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

export function onOpenCommandPalette(handler: () => void): () => void {
  window.addEventListener(OPEN_PALETTE_EVENT, handler);
  return () => window.removeEventListener(OPEN_PALETTE_EVENT, handler);
}
