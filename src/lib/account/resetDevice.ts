import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useThemeStore } from "@/stores/themeStore";

/** Wipes everything local. Never throws; returns what could not be cleared (empty = clean). */
export async function resetDevice(
  teardown: () => Promise<string[] | void>,
): Promise<string[]> {
  const failures: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await step("sign out", async () => {
    failures.push(...((await teardown()) ?? []));
  });
  for (const file of ["settings.json", "team-cache.json"]) {
    await step(file, async () => {
      const s = await load(file, { autoSave: false });
      await s.clear();
      await s.save();
    });
  }
  await step("local storage", () => localStorage.clear());
  try {
    failures.push(...(await invoke<string[]>("reset_device_files")));
  } catch (e) {
    failures.push(
      `device files: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await step("settings", () => useSettingsStore.getState().initSettings());
  await step("shortcuts", () => useShortcutStore.setState({ overrides: {} }));
  await step("theme", () => useThemeStore.getState().initTheme());
  return failures;
}
