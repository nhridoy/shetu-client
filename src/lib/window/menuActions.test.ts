import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "@/lib/shortcuts/registry";
import menuRs from "../../../src-tauri/src/menu.rs?raw";
import { isMenuActionId, isModalOpen, MENU_ACTION_IDS } from "./menuActions";

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
});
