// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  fail: false,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    if (disk.fail) throw new Error("no store");
    return {
      get: async (k: string) => disk.saved[k],
      set: async (k: string, v: unknown) => {
        disk.saved[k] = v;
      },
      save: async () => {},
    };
  }),
}));

import {
  effectiveBinding,
  findConflict,
  isHeldBackFromTerminal,
  isShortcutDisabled,
  shadowedAppShortcut,
  useShortcutStore,
} from "./shortcutStore";

const ev = (code: string, mods: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { code, ...mods });

beforeEach(() => {
  disk.saved = {};
  disk.fail = false;
  useShortcutStore.setState({
    overrides: {},
    activeContext: null,
    recording: false,
  });
});

describe("shortcut store", () => {
  it("defaults_apply_without_overrides", () => {
    expect(effectiveBinding("terminal.newTab", { overrides: {} }, false)).toBe(
      "ctrl+shift+t",
    );
    expect(effectiveBinding("terminal.newTab", { overrides: {} }, true)).toBe(
      "meta+t",
    );
    expect(effectiveBinding("files.copy", { overrides: {} }, true)).toBe(
      "meta+c",
    );
  });

  it("set_binding_persists_only_overrides", async () => {
    await useShortcutStore
      .getState()
      .setBinding("terminal.palette", "ctrl+alt+p");
    expect(disk.saved.shortcuts).toEqual({ "terminal.palette": "ctrl+alt+p" });
    expect(effectiveBinding("terminal.palette", undefined, false)).toBe(
      "ctrl+alt+p",
    );
    await useShortcutStore
      .getState()
      .setBinding("terminal.palette", "ctrl+shift+p");
    expect(disk.saved.shortcuts).toEqual({});
  });

  it("reset_one_and_all", async () => {
    const s = useShortcutStore.getState();
    await s.setBinding("terminal.palette", "ctrl+alt+p");
    await s.setBinding("files.copy", "");
    await useShortcutStore.getState().resetBinding("terminal.palette");
    expect(disk.saved.shortcuts).toEqual({ "files.copy": "" });
    await useShortcutStore.getState().resetAll();
    expect(disk.saved.shortcuts).toEqual({});
    expect(useShortcutStore.getState().overrides).toEqual({});
  });

  it("load_ignores_corrupt_values", async () => {
    for (const bad of [
      "ctrl+t",
      ["x"],
      { "nope.id": "ctrl+x", "terminal.newTab": "ctrl+", "files.copy": 5 },
    ]) {
      disk.saved.shortcuts = bad;
      await useShortcutStore.getState().initShortcuts();
      expect(effectiveBinding("terminal.newTab", undefined, false)).toBe(
        "ctrl+shift+t",
      );
      expect(effectiveBinding("files.copy", undefined, false)).toBe("ctrl+c");
    }
  });

  it("load_keeps_valid_overrides", async () => {
    disk.saved.shortcuts = { "files.copy": "ctrl+alt+c", "files.cut": "" };
    await useShortcutStore.getState().initShortcuts();
    expect(effectiveBinding("files.copy", undefined, false)).toBe("ctrl+alt+c");
    expect(effectiveBinding("files.cut", undefined, false)).toBe("");
  });

  it("load_failure_keeps_defaults", async () => {
    disk.fail = true;
    await useShortcutStore.getState().initShortcuts();
    expect(useShortcutStore.getState().overrides).toEqual({});
  });

  it("conflicts_are_per_context", () => {
    expect(findConflict("files.copy", "ctrl+x", false)).toBe("files.cut");
    expect(findConflict("editor.copyPath", "ctrl+x", false)).toBeNull();
    expect(findConflict("files.copy", "ctrl+shift+k", false)).toBeNull(); // shadows app-wide
    expect(findConflict("app.settings", "ctrl+shift+k", false)).toBe(
      "app.quickConnect",
    );
    expect(findConflict("files.copy", "ctrl+c", false)).toBeNull(); // itself
    expect(findConflict("files.copy", "", false)).toBeNull();
  });

  it("view_binding_shadows_app_wide", () => {
    useShortcutStore.setState({
      overrides: { "editor.quickOpen": "ctrl+shift+k" },
    });
    expect(findConflict("editor.quickOpen", "ctrl+shift+k", false)).toBeNull();
    expect(shadowedAppShortcut("editor.quickOpen", false)).toBe(
      "app.quickConnect",
    );
    expect(shadowedAppShortcut("files.copy", false)).toBeNull();
  });

  it("mac_menu_items_conflict_everywhere", () => {
    expect(findConflict("editor.quickOpen", "meta+t", true)).toBe(
      "terminal.newTab",
    );
    expect(findConflict("editor.quickOpen", "meta+k", true)).toBe(
      "app.quickConnect",
    );
  });

  it("held_back_from_terminal", () => {
    expect(
      isHeldBackFromTerminal(
        ev("KeyT", { ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true);
    expect(
      isHeldBackFromTerminal(ev("Backslash", { ctrlKey: true }), false),
    ).toBe(true);
    expect(isHeldBackFromTerminal(ev("KeyW", { ctrlKey: true }), false)).toBe(
      false,
    );
    // File-browser keys are not terminal keys.
    expect(isHeldBackFromTerminal(ev("F5"), false)).toBe(false);
  });

  it("slash_is_never_held_back", () => {
    expect(isHeldBackFromTerminal(ev("Slash"), false)).toBe(false);
  });

  it("empty_binding_disables_and_is_not_held_back", async () => {
    await useShortcutStore.getState().setBinding("terminal.splitRight", "");
    expect(isShortcutDisabled("terminal.splitRight")).toBe(true);
    expect(
      isHeldBackFromTerminal(ev("Backslash", { ctrlKey: true }), false),
    ).toBe(false);
  });

  it("recording_disables_everything", () => {
    expect(isShortcutDisabled("app.quickConnect")).toBe(false);
    useShortcutStore.getState().setRecording(true);
    expect(isShortcutDisabled("app.quickConnect")).toBe(true);
  });
});
