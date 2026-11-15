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

export type ResolvedCommand =
  | { status: "ok"; command: string }
  | { status: "cancelled" | "decrypt-failed" };

/** The command a palette pick stands for: decrypted and with its variables filled. */
export async function resolvePaletteCommand(
  item: PaletteItem,
  deps: Pick<
    Parameters<typeof pickPaletteItem>[2],
    "decryptSnippet" | "askVariables"
  >,
): Promise<ResolvedCommand> {
  let command = item.command;
  if (item.snippetId) {
    const snippet = await deps.decryptSnippet(item.snippetId).catch(() => null);
    if (!snippet) return { status: "decrypt-failed" };
    command = snippet.command;
  }
  const names = snippetVariables(command);
  if (names.length === 0) return { status: "ok", command };
  const values = await deps.askVariables(names);
  return values
    ? { status: "ok", command: fillSnippet(command, values) }
    : { status: "cancelled" };
}

/**
 * Runs the command in every connected pane of every tab, in the background. Each pane
 * is typed into directly with fan-out off, so broadcast never runs it a second time.
 */
export function runInAllTabs(
  command: string,
  deps: {
    tabs: Pick<TerminalTab, "root">[];
    insert(
      paneId: string,
      text: string,
      run: boolean,
      options: { focus: boolean; fanOut: boolean },
    ): string;
  },
): { ran: number; local: number } {
  let ran = 0;
  let local = 0;
  for (const tab of deps.tabs)
    for (const leaf of findAllLeaves(tab.root)) {
      if (leaf.connectionStatus !== "connected") continue;
      if (
        deps.insert(leaf.id, command, true, { focus: false, fanOut: false }) !==
        "ok"
      )
        continue;
      ran++;
      if (leaf.connectionType === "local") local++;
    }
  return { ran, local };
}

export type PaletteMode = "all" | "snippets";

const OPEN_PALETTE_EVENT = "shetu:open-command-palette";

/** Opens the command palette, e.g. from a pane's context menu ("snippets" filters to them). */
export function openCommandPalette(mode: PaletteMode = "all"): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: mode }));
}

export function onOpenCommandPalette(
  handler: (mode: PaletteMode) => void,
): () => void {
  const listener = (e: Event) =>
    handler(
      (e as CustomEvent<PaletteMode>).detail === "snippets"
        ? "snippets"
        : "all",
    );
  window.addEventListener(OPEN_PALETTE_EVENT, listener);
  return () => window.removeEventListener(OPEN_PALETTE_EVENT, listener);
}

/** Puts a palette pick into the terminal; resolves true when done (the palette closes). */
export type SnippetPicker = (
  item: PaletteItem,
  run: boolean,
  all: boolean,
) => Promise<boolean>;

let picker: SnippetPicker | null = null;

/** The terminal view registers its picker while mounted; returns the unregister. */
export function setTerminalSnippetPicker(p: SnippetPicker): () => void {
  picker = p;
  return () => {
    if (picker === p) picker = null;
  };
}

export function terminalSnippetPicker(): SnippetPicker | null {
  return picker;
}

/** Common commands listed under snippets in the terminal. */
export const BUILTIN_COMMANDS: {
  name: string;
  command: string;
  description: string;
}[] = [
  {
    name: "ls -la",
    command: "ls -la",
    description: "List files with details",
  },
  { name: "cd", command: "cd ", description: "Change directory" },
  { name: "pwd", command: "pwd", description: "Print working directory" },
  { name: "mkdir", command: "mkdir ", description: "Create directory" },
  {
    name: "rm -rf",
    command: "rm -rf ",
    description: "Remove files (careful!)",
  },
  { name: "cp -r", command: "cp -r ", description: "Copy recursively" },
  { name: "mv", command: "mv ", description: "Move/rename" },
  { name: "chmod", command: "chmod ", description: "Change permissions" },
  { name: "chown", command: "chown ", description: "Change ownership" },
  { name: "cat", command: "cat ", description: "View file contents" },
  {
    name: "tail -f",
    command: "tail -f ",
    description: "Follow file changes",
  },
  { name: "grep", command: "grep ", description: "Search text" },
  { name: "find", command: "find ", description: "Find files" },
  { name: "ps aux", command: "ps aux", description: "List processes" },
  { name: "top", command: "top", description: "Process monitor" },
  { name: "htop", command: "htop", description: "Better process monitor" },
  { name: "df -h", command: "df -h", description: "Disk usage" },
  { name: "du -sh", command: "du -sh ", description: "Directory size" },
  { name: "free -m", command: "free -m", description: "Memory usage" },
  { name: "uptime", command: "uptime", description: "System uptime" },
  { name: "whoami", command: "whoami", description: "Current user" },
  { name: "hostname", command: "hostname", description: "System hostname" },
  { name: "uname -a", command: "uname -a", description: "System info" },
  { name: "curl", command: "curl ", description: "HTTP requests" },
  { name: "wget", command: "wget ", description: "Download files" },
  { name: "ssh", command: "ssh ", description: "SSH connect" },
  { name: "scp", command: "scp ", description: "Secure copy" },
  { name: "rsync", command: "rsync ", description: "Sync files" },
  { name: "git status", command: "git status", description: "Git status" },
  { name: "git pull", command: "git pull", description: "Git pull" },
  { name: "git push", command: "git push", description: "Git push" },
  {
    name: "docker ps",
    command: "docker ps",
    description: "Docker containers",
  },
  {
    name: "docker compose",
    command: "docker compose ",
    description: "Docker Compose",
  },
  {
    name: "systemctl status",
    command: "systemctl status ",
    description: "Service status",
  },
  {
    name: "systemctl restart",
    command: "systemctl restart ",
    description: "Restart service",
  },
  { name: "journalctl", command: "journalctl -u ", description: "View logs" },
];
