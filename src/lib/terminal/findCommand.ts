import { useTerminalStore } from "@/stores/terminal/terminalStore";

const OPEN_FIND_EVENT = "shetu:open-terminal-find";

/** Asks the active terminal pane to open its find bar. */
export function openFind(): void {
  window.dispatchEvent(new Event(OPEN_FIND_EVENT));
}

export function onOpenFind(handler: () => void): () => void {
  window.addEventListener(OPEN_FIND_EVENT, handler);
  return () => window.removeEventListener(OPEN_FIND_EVENT, handler);
}

/** Only the active pane of the tab on screen opens find; hidden tabs stay mounted. */
export function findOpensHere(tabId: string, isActive: boolean): boolean {
  return isActive && useTerminalStore.getState().activeTabId === tabId;
}
