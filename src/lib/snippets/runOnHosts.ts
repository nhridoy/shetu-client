import { fillSnippet, snippetVariables } from "@/lib/snippets/variables";
import { runWhenConnected } from "@/lib/terminal/runWhenConnected";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { askSnippetVariables } from "@/stores/snippets/snippetVariablesStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

/**
 * Termius-style "Run on hosts": one new tab per host, the snippet runs in each as soon
 * as it connects. Variables are asked once and used for every host.
 */
export async function runOnHosts(
  snippetId: string,
  hostIds: string[],
): Promise<"ok" | "cancelled" | "no-hosts" | "decrypt-failed"> {
  const hosts = useHostStore
    .getState()
    .hosts.filter((h) => hostIds.includes(h.id));
  if (hosts.length === 0) return "no-hosts";
  const snippet = await useSnippetStore
    .getState()
    .getDecryptedSnippet(snippetId)
    .catch(() => null);
  if (!snippet) return "decrypt-failed";
  let command = snippet.command;
  const names = snippetVariables(command);
  if (names.length > 0) {
    const values = await askSnippetVariables(names);
    if (!values) return "cancelled";
    command = fillSnippet(command, values);
  }
  for (const host of hosts) {
    useTerminalStore.getState().addTab(host.id, host.name);
    const { activeTabId, tabs } = useTerminalStore.getState();
    const pane = tabs.find((t) => t.id === activeTabId)?.activePaneId;
    if (activeTabId && pane) runWhenConnected(activeTabId, pane, command);
  }
  return "ok";
}
