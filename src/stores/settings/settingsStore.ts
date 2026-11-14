import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";

export type CursorStyle = "block" | "underline" | "bar";
export type BellStyle = "none" | "sound" | "visual";
export type SshTerminalType = "xterm-256color" | "xterm" | "vt100";

export interface AppSettings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  bellStyle: BellStyle;
  recordTerminalOutput: boolean;
  trustNewHosts: boolean;
  sshKeepaliveSecs: number;
  sshConnectTimeoutSecs: number;
  sshTerminalType: SshTerminalType;
  sshAgentPath: string;
  /** Host id → whether this device allows agent forwarding to it. Device-local, never synced. */
  agentForwardingDecisions: Record<string, boolean>;
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
  trustNewHosts: false,
  sshKeepaliveSecs: 30,
  sshConnectTimeoutSecs: 10,
  sshTerminalType: "xterm-256color",
  sshAgentPath: "",
  agentForwardingDecisions: {},
};

const SSH_TERMS: string[] = ["xterm-256color", "xterm", "vt100"];

const STORE_KEY = "settings.json";

// Rust starts with this off, so a failed push never trusts more than the user chose.
function pushTrustNewHosts(enabled: boolean) {
  void invoke("set_trust_new_hosts", { enabled }).catch(() => {});
}

function pushSshDefaults(s: AppSettings) {
  void invoke("set_ssh_defaults", {
    keepaliveSecs: s.sshKeepaliveSecs,
    connectTimeoutSecs: s.sshConnectTimeoutSecs,
    term: s.sshTerminalType,
    agentPath: s.sshAgentPath,
  }).catch(() => {});
}

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
  // Junk in settings.json must not reach Rust (NaN → null fails its i64 args).
  const ka = merged.sshKeepaliveSecs;
  if (!Number.isInteger(ka) || !(ka === 0 || (ka >= 5 && ka <= 600)))
    merged.sshKeepaliveSecs = DEFAULT_SETTINGS.sshKeepaliveSecs;
  const ct = merged.sshConnectTimeoutSecs;
  if (!Number.isInteger(ct) || ct < 5 || ct > 60)
    merged.sshConnectTimeoutSecs = DEFAULT_SETTINGS.sshConnectTimeoutSecs;
  if (!SSH_TERMS.includes(merged.sshTerminalType))
    merged.sshTerminalType = DEFAULT_SETTINGS.sshTerminalType;
  if (typeof merged.sshAgentPath !== "string")
    merged.sshAgentPath = DEFAULT_SETTINGS.sshAgentPath;
  const decisions: unknown = merged.agentForwardingDecisions;
  merged.agentForwardingDecisions =
    decisions && typeof decisions === "object" && !Array.isArray(decisions)
      ? Object.fromEntries(
          Object.entries(decisions).filter(([, v]) => typeof v === "boolean"),
        )
      : {};
  return merged;
}

function parseValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (key === "agentForwardingDecisions") return value; // validated in mergeSettings
  if (
    key === "fontSize" ||
    key === "scrollback" ||
    key === "sshKeepaliveSecs" ||
    key === "sshConnectTimeoutSecs"
  ) {
    return typeof value === "number"
      ? value
      : Number.parseInt(String(value), 10);
  }
  if (
    key === "cursorBlink" ||
    key === "recordTerminalOutput" ||
    key === "trustNewHosts"
  ) {
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
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
    const settings = mergeSettings(saved);
    set({ settings, isLoading: false, isLoaded: true });
    pushTrustNewHosts(settings.trustNewHosts);
    pushSshDefaults(settings);
  },

  updateSetting: async (key, value) => {
    const next = { ...get().settings, [key]: value };
    set({ settings: next });
    if (key.startsWith("ssh")) pushSshDefaults(next);
    if (key === "trustNewHosts") pushTrustNewHosts(value as boolean);
    try {
      const store = await load(STORE_KEY, { autoSave: false });
      await store.set(key, value);
      await store.save();
    } catch {
      // best-effort: the in-memory value still applies for this session
    }
  },
}));
