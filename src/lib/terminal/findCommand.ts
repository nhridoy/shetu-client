const OPEN_FIND_EVENT = "shetu:open-terminal-find";

/** Asks the active terminal pane to open its find bar. */
export function openFind(): void {
  window.dispatchEvent(new Event(OPEN_FIND_EVENT));
}

export function onOpenFind(handler: () => void): () => void {
  window.addEventListener(OPEN_FIND_EVENT, handler);
  return () => window.removeEventListener(OPEN_FIND_EVENT, handler);
}
