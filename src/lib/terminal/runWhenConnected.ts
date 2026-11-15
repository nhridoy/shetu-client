import { findLeaf, useTerminalStore } from "@/stores/terminal/terminalStore";
import { insertIntoPane } from "./sessionManager";

const GIVE_UP_MS = 120_000;

/**
 * Runs `command` in the pane the first time it connects. Stops waiting if the pane
 * closes, its connection fails, or two minutes pass. Returns a cancel function.
 */
export function runWhenConnected(
  tabId: string,
  paneId: string,
  command: string,
): () => void {
  let done = false;
  const stop = () => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const check = () => {
    if (done) return;
    const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
    const leaf = tab ? findLeaf(tab.root, paneId) : null;
    // Anything but still-connecting (error, failed, closed) ends the wait: a later
    // manual reconnect must not run the command after all.
    if (!leaf || !["connecting", "connected"].includes(leaf.connectionStatus))
      return stop();
    if (leaf.connectionStatus !== "connected") return;
    stop();
    // Safe insert (control characters stripped, one Enter), without taking focus from
    // whatever the user is typing in, such as another host's password prompt.
    insertIntoPane(paneId, command, true, { focus: false });
  };
  const unsubscribe = useTerminalStore.subscribe(check);
  const timer = setTimeout(stop, GIVE_UP_MS);
  check();
  return stop;
}
