import { listen } from "@tauri-apps/api/event";
import { isTauriAvailable } from "@/lib/common/utils";

/** App-wide commands shared by the macOS menu bar and in-app shortcuts. */
export type MenuActionId =
  | "settings"
  | "new-tab"
  | "quick-connect"
  | "close-tab";

export const MENU_ACTION_IDS: readonly MenuActionId[] = [
  "settings",
  "new-tab",
  "quick-connect",
  "close-tab",
];

/** Tauri event the macOS menu emits (payload: the id). Must match menu.rs. */
export const MENU_ACTION_EVENT = "menu-action";

const APP_ACTION_DOM_EVENT = "shetu:app-action";

export function isMenuActionId(value: unknown): value is MenuActionId {
  return MENU_ACTION_IDS.includes(value as MenuActionId);
}

export function dispatchAppAction(id: MenuActionId): void {
  window.dispatchEvent(new CustomEvent(APP_ACTION_DOM_EVENT, { detail: id }));
}

export function listenAppActions(
  handler: (id: MenuActionId) => void,
): () => void {
  const onDom = (event: Event) => {
    const id = (event as CustomEvent<unknown>).detail;
    if (isMenuActionId(id)) handler(id);
  };
  window.addEventListener(APP_ACTION_DOM_EVENT, onDom);

  let disposed = false;
  let unlistenTauri: (() => void) | undefined;
  if (isTauriAvailable()) {
    void listen<unknown>(MENU_ACTION_EVENT, ({ payload }) => {
      if (isMenuActionId(payload)) handler(payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlistenTauri = stop;
      })
      .catch(() => {});
  }

  return () => {
    disposed = true;
    window.removeEventListener(APP_ACTION_DOM_EVENT, onDom);
    unlistenTauri?.();
  };
}

/** True when the native macOS menu bar is installed (Tauri app on a Mac). */
export function hasMacMenu(): boolean {
  return (
    isTauriAvailable() &&
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent)
  );
}

/** True while a modal dialog (Modal, Settings, Quick Connect…) is on screen. */
export function isModalOpen(
  doc: Pick<Document, "querySelector"> = document,
): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}
