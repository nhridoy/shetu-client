import { findAllLeaves } from "@/lib/common/treeUtils";
import { fillSnippet, snippetVariables } from "@/lib/snippets/variables";
import type { TerminalTab } from "@/stores/terminal/terminalStore";

/** A command palette entry: a user snippet (decrypted on pick) or a built-in command. */
export type PaletteItem = { snippetId?: string; command: string };

export type PickResult =
  | "ok"
  | "no-pane"
  | "not-connected"
  | "decrypt-failed"
  | "unsafe-multiline"
  | "empty"
  | "cancelled";

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
    /** Values for the snippet's {{variables}}; null when the user cancels. */
    askVariables(names: string[]): Promise<Record<string, string> | null>;
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
  const names = snippetVariables(command);
  if (names.length > 0) {
    const values = await deps.askVariables(names);
    if (!values) return "cancelled";
    command = fillSnippet(command, values);
    if (!deps.isConnected(deps.activePaneId)) return "not-connected";
  }
  return deps.insert(deps.activePaneId, command, run);
}

/** The command a palette pick stands for: decrypted and with its variables filled. */
export async function resolvePaletteCommand(
  item: PaletteItem,
  deps: Pick<
    Parameters<typeof pickPaletteItem>[2],
    "decryptSnippet" | "askVariables"
  >,
): Promise<string | "decrypt-failed" | "cancelled"> {
  let command = item.command;
  if (item.snippetId) {
    const snippet = await deps.decryptSnippet(item.snippetId).catch(() => null);
    if (!snippet) return "decrypt-failed";
    command = snippet.command;
  }
  const names = snippetVariables(command);
  if (names.length === 0) return command;
  const values = await deps.askVariables(names);
  return values ? fillSnippet(command, values) : "cancelled";
}

/** Runs the command in every connected pane of every tab; returns how many took it. */
export function runInAllTabs(
  command: string,
  deps: {
    tabs: Pick<TerminalTab, "root">[];
    insert(paneId: string, text: string, run: boolean): string;
  },
): number {
  let ran = 0;
  for (const tab of deps.tabs)
    for (const leaf of findAllLeaves(tab.root))
      if (
        leaf.connectionStatus === "connected" &&
        deps.insert(leaf.id, command, true) === "ok"
      )
        ran++;
  return ran;
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
