// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { SHORTCUTS } from "@/lib/shortcuts/registry";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import menuRs from "../../../src-tauri/src/menu.rs?raw";
import {
  dispatchAppAction,
  isMenuActionId,
  isModalOpen,
  listenAppActions,
  MENU_ACTION_IDS,
} from "./menuActions";

describe("menu actions", () => {
  it("validates ids", () => {
    expect(MENU_ACTION_IDS.every(isMenuActionId)).toBe(true);
    expect(isMenuActionId("quit")).toBe(false);
    expect(isMenuActionId(undefined)).toBe(false);
  });

  it("every frontend id is emitted by the Rust menu", () => {
    expect(menuRs).toContain(`"${"menu-action"}"`);
    for (const id of MENU_ACTION_IDS) expect(menuRs).toContain(`"${id}"`);
  });

  it("every menu item is a shortcut in the registry", () => {
    const items = SHORTCUTS.flatMap((d) => (d.menuItem ? [d.menuItem] : []));
    expect([...items].sort()).toEqual([...MENU_ACTION_IDS].sort());
  });

  it("detects an open modal dialog", () => {
    const doc = (hit: boolean) => ({
      querySelector: (sel: string) =>
        hit && sel === '[aria-modal="true"]' ? ({} as Element) : null,
    });
    expect(isModalOpen(doc(true))).toBe(true);
    expect(isModalOpen(doc(false))).toBe(false);
  });

  it("menu actions do nothing while Shetu is locked", () => {
    const handler = vi.fn();
    const stop = listenAppActions(handler);
    useShortcutStore.setState({ locked: true });
    dispatchAppAction("new-tab");
    expect(handler).not.toHaveBeenCalled();
    useShortcutStore.setState({ locked: false });
    dispatchAppAction("new-tab");
    expect(handler).toHaveBeenCalledWith("new-tab");
    stop();
  });
});
