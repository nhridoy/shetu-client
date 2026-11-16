// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lockSession: vi.fn(),
  systemLock: null as null | ((e: { payload: string }) => void),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(),
    set: vi.fn(),
    save: vi.fn(),
    entries: vi.fn(async () => []),
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: string }) => void) => {
    if (name === "system-lock") h.systemLock = cb;
    return () => {};
  }),
}));
vi.mock("@/stores/auth/authStore", async () => {
  const { create } = await import("zustand");
  const useAuthStore = create<{
    isUnlocked: boolean;
    appLocked: boolean;
    lockApp: () => Promise<void>;
  }>((set, get) => ({
    isUnlocked: true,
    appLocked: false,
    lockApp: async () => {
      if (!get().isUnlocked || get().appLocked) return;
      set({ appLocked: true, isUnlocked: false });
      h.lockSession();
    },
  }));
  return { useAuthStore };
});

import { useAuthStore } from "@/stores/auth/authStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useAppLock } from "./useAppLock";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
function Probe() {
  useAppLock();
  return null;
}
function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root?.render(<Probe />));
}
const setLock = (minutes: number, onSystem = true) =>
  act(() =>
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        lockAfterIdleMinutes: minutes,
        lockOnSystemLock: onSystem,
      },
    })),
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.systemLock = null;
  useAuthStore.setState({ isUnlocked: true, appLocked: false });
  useShortcutStore.setState({ overrides: {}, recording: false, locked: false });
  setLock(0);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useAppLock", () => {
  it("idle_locks_after_set_minutes", () => {
    setLock(5);
    mount();
    advance(5 * MIN - 1000);
    expect(h.lockSession).not.toHaveBeenCalled();
    advance(1000);
    expect(h.lockSession).toHaveBeenCalledTimes(1);
  });

  it("activity_resets_idle", () => {
    setLock(5);
    mount();
    advance(4 * MIN);
    act(() => window.dispatchEvent(new Event("pointermove")));
    advance(1 * MIN);
    expect(h.lockSession).not.toHaveBeenCalled();
    advance(4 * MIN);
    expect(h.lockSession).toHaveBeenCalledTimes(1);
  });

  it("idle_off_never_locks", () => {
    mount();
    advance(120 * MIN);
    expect(h.lockSession).not.toHaveBeenCalled();
  });

  it("shortcut_locks", () => {
    mount();
    act(() => {
      for (const type of ["keydown", "keyup"])
        document.body.dispatchEvent(
          new KeyboardEvent(type, {
            key: "L",
            code: "KeyL",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        );
    });
    expect(h.lockSession).toHaveBeenCalledTimes(1);
  });

  it("system_lock_event_respects_setting", async () => {
    mount();
    await act(async () => {});
    act(() => h.systemLock?.({ payload: "sleep" }));
    expect(h.lockSession).toHaveBeenCalledTimes(1);
    useAuthStore.setState({ isUnlocked: true, appLocked: false });
    setLock(0, false);
    act(() => h.systemLock?.({ payload: "screen" }));
    expect(h.lockSession).toHaveBeenCalledTimes(1);
  });

  it("triggers_ignored_when_not_unlocked", async () => {
    setLock(1);
    useAuthStore.setState({ isUnlocked: false });
    mount();
    await act(async () => {});
    advance(5 * MIN);
    act(() => h.systemLock?.({ payload: "sleep" }));
    expect(h.lockSession).not.toHaveBeenCalled();
  });

  it("repeated_lock_is_a_no_op", async () => {
    setLock(1);
    mount();
    await act(async () => {});
    advance(1 * MIN);
    act(() => h.systemLock?.({ payload: "sleep" }));
    expect(h.lockSession).toHaveBeenCalledTimes(1);
  });
});
