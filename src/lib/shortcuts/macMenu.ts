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
  const accel = (id: Parameters<typeof effectiveBinding>[0]) =>
    toTauriAccelerator(effectiveBinding(id));
  await invoke("set_menu_accelerators", {
    accelerators: {
      "new-tab": accel("terminal.newTab"),
      "close-tab": accel("terminal.closePane"),
      "quick-connect": accel("app.quickConnect"),
      settings: accel("app.settings"),
    },
  }).catch(() => {});
}

/** Syncs now and after every binding change; returns a stop function. */
export function watchMacMenu(): () => void {
  void syncMacMenu();
  return useShortcutStore.subscribe((s, prev) => {
    if (s.overrides !== prev.overrides) void syncMacMenu();
  });
}
