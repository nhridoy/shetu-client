/** A command palette entry: a user snippet (decrypted on pick) or a built-in command. */
export type PaletteItem = { snippetId?: string; command: string };

export type PickResult = "ok" | "no-pane" | "decrypt-failed";

/** Puts the picked command into the active pane: inserted, or run when `run`. */
export async function pickPaletteItem(
  item: PaletteItem,
  run: boolean,
  deps: {
    activePaneId: string | null;
    decryptSnippet(id: string): Promise<{ command: string } | null>;
    insert(paneId: string, text: string, run: boolean): boolean;
  },
): Promise<PickResult> {
  if (!deps.activePaneId) return "no-pane";
  let command = item.command;
  if (item.snippetId) {
    // Snippet commands are encrypted in list state; decrypt only the one picked.
    const snippet = await deps.decryptSnippet(item.snippetId).catch(() => null);
    if (!snippet) return "decrypt-failed";
    command = snippet.command;
  }
  return deps.insert(deps.activePaneId, command, run) ? "ok" : "no-pane";
}
