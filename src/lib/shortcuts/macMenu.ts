import { invoke } from "@tauri-apps/api/core";
import { hasMacMenu } from "@/lib/window/menuActions";
import {
  effectiveBinding,
  useShortcutStore,
} from "@/stores/shortcuts/shortcutStore";
import { toTauriAccelerator } from "./binding";

/** Pushes the menu-bar shortcuts' bindings to the native macOS menu. */
export async function syncMacMenu(): Promise<void> {
  if (!hasMacMenu()) return;
  // While the Keyboard tab records, the native menu must not grab ⌘W or ⌘K first.
  const recording = useShortcutStore.getState().recording;
  const accel = (id: Parameters<typeof effectiveBinding>[0]) =>
    recording ? null : toTauriAccelerator(effectiveBinding(id));
  await invoke("set_menu_accelerators", {
    accelerators: {
      "new-tab": accel("terminal.newTab"),
      "close-tab": accel("terminal.closePane"),
      "quick-connect": accel("app.quickConnect"),
      settings: accel("app.settings"),
    },
  }).catch(() => {});
}

/** Syncs now, after every binding change, and when recording starts or stops. */
export function watchMacMenu(): () => void {
  void syncMacMenu();
  return useShortcutStore.subscribe((s, prev) => {
    if (s.overrides !== prev.overrides || s.recording !== prev.recording)
      void syncMacMenu();
  });
}
