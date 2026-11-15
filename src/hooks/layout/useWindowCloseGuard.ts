import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { isTauriAvailable } from "@/lib/common/utils";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";

/** Native close requests (Alt+F4, dock, our titlebar) ask before dropping unsaved edits. */
export function useWindowCloseGuard() {
  useEffect(() => {
    if (!isTauriAvailable()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested(async (e) => {
        const unsaved = useUnsavedChanges.getState();
        if (!unsaved.dirty) return;
        e.preventDefault();
        if (await unsaved.confirmLeave()) await win.destroy();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
