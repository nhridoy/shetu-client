import { toast } from "sonner";
import { findAllLeaves } from "@/lib/common/treeUtils";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

/** Turns a tab's broadcast on or off; warns when local shells would get the input too. */
export function toggleTabBroadcast(tabId: string): void {
  const store = useTerminalStore.getState();
  store.toggleBroadcast(tabId);
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.broadcast) return;
  const local = findAllLeaves(tab.root).filter(
    (l) => l.connectionType === "local",
  ).length;
  if (local)
    toast.warning(
      `Broadcast includes ${local} local shell${local === 1 ? "" : "s"} on this computer`,
    );
}
