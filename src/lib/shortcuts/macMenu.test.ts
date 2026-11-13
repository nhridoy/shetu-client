import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ macMenu: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));
vi.mock("@/lib/window/menuActions", () => ({
  hasMacMenu: () => mocks.macMenu,
}));

import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { syncMacMenu, watchMacMenu } from "./macMenu";

const realPlatform = navigator.platform;
beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  mocks.macMenu = true;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  useShortcutStore.setState({ overrides: {} });
});
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

const DEFAULTS = {
  "new-tab": "Cmd+T",
  "close-tab": "Cmd+W",
  "quick-connect": "Cmd+K",
  settings: "Cmd+,",
};

describe("macOS menu sync", () => {
  it("syncs_the_four_menu_items_on_macos", async () => {
    await syncMacMenu();
    expect(mocks.invoke).toHaveBeenCalledWith("set_menu_accelerators", {
      accelerators: DEFAULTS,
    });
  });

  it("empty_binding_removes_the_accelerator", async () => {
    useShortcutStore.setState({ overrides: { "terminal.newTab": "" } });
    await syncMacMenu();
    expect(mocks.invoke).toHaveBeenCalledWith("set_menu_accelerators", {
      accelerators: { ...DEFAULTS, "new-tab": null },
    });
  });

  it("does_nothing_without_the_mac_menu", async () => {
    mocks.macMenu = false;
    await syncMacMenu();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("follows_binding_changes", async () => {
    const stop = watchMacMenu();
    await useShortcutStore
      .getState()
      .setBinding("app.settings", "shift+meta+comma");
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenLastCalledWith("set_menu_accelerators", {
        accelerators: { ...DEFAULTS, settings: "Shift+Cmd+," },
      }),
    );
    stop();
  });
});
