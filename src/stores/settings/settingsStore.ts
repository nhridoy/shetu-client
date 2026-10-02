import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";

export type CursorStyle = "block" | "underline" | "bar";
export type BellStyle = "none" | "sound" | "visual";

export interface AppSettings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  bellStyle: BellStyle;
  recordTerminalOutput: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  fontFamily: "JetBrains Mono",
  fontSize: 14,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  bellStyle: "none",
  recordTerminalOutput: false,
};

const STORE_KEY = "settings.json";

function mergeSettings(saved: Partial<AppSettings> | null): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS };
  if (saved) {
    for (const key of Object.keys(saved) as (keyof AppSettings)[]) {
      const val = saved[key];
      if (val !== undefined && val !== null) {
        (merged as unknown as Record<string, unknown>)[key] = val;
      }
    }
  }
  return merged;
}

function parseValue(
  key: string,
  value: unknown,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (key === "fontSize" || key === "scrollback") {
    return typeof value === "number"
      ? value
      : Number.parseInt(String(value), 10);
  }
  if (key === "cursorBlink" || key === "recordTerminalOutput") {
    return typeof value === "boolean" ? value : value === "true";
  }
  return String(value);
}

interface SettingsState {
  settings: AppSettings;
  isLoading: boolean;
  isLoaded: boolean;
  initSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  isLoaded: false,

  initSettings: async () => {
    set({ isLoading: true });
    let saved: Partial<AppSettings> | null = null;
    try {
      const store = await load(STORE_KEY, { autoSave: false });
      const all = (await store.entries()) as [string, unknown][];
      saved = {};
      for (const [key, value] of all) {
        const parsed = parseValue(key, value);
        if (parsed !== null && key in DEFAULT_SETTINGS) {
          (saved as Record<string, unknown>)[key] = parsed;
        }
      }
    } catch {
      saved = null;
    }
    set({
      settings: mergeSettings(saved),
      isLoading: false,
      isLoaded: true,
    });
  },

  updateSetting: async (key, value) => {
    set((s) => ({
      settings: { ...s.settings, [key]: value },
    }));
    try {
      const store = await load(STORE_KEY, { autoSave: false });
      await store.set(key, value);
      await store.save();
    } catch {
      // best-effort: the in-memory value still applies for this session
    }
  },
}));
