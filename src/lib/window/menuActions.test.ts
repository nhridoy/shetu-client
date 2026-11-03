import { describe, expect, it } from "vitest";
import menuRs from "../../../src-tauri/src/menu.rs?raw";
import {
  classifyQuickConnectKey,
  isMenuActionId,
  isMenuOwnedShortcut,
  isModalOpen,
  MENU_ACTION_IDS,
} from "./menuActions";

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }) as KeyboardEvent;

describe("menu actions", () => {
  it("claims only ⌘T ⌘W ⌘K ⌘, on mac", () => {
    for (const k of ["t", "w", "k", ",", "K"]) {
      expect(isMenuOwnedShortcut(key(k, { metaKey: true }), true)).toBe(true);
    }
    expect(isMenuOwnedShortcut(key("t", { metaKey: true }), false)).toBe(false);
    expect(isMenuOwnedShortcut(key("t", { ctrlKey: true }), true)).toBe(false);
    expect(
      isMenuOwnedShortcut(key("t", { metaKey: true, shiftKey: true }), true),
    ).toBe(false);
    expect(isMenuOwnedShortcut(key("s", { metaKey: true }), true)).toBe(false);
  });

  it("validates ids", () => {
    expect(MENU_ACTION_IDS.every(isMenuActionId)).toBe(true);
    expect(isMenuActionId("quit")).toBe(false);
    expect(isMenuActionId(undefined)).toBe(false);
  });

  it("every frontend id is emitted by the Rust menu", () => {
    expect(menuRs).toContain(`"${"menu-action"}"`);
    for (const id of MENU_ACTION_IDS) expect(menuRs).toContain(`"${id}"`);
  });

  it("leaves ⌘K untouched for the macOS menu, claims it elsewhere", () => {
    // The page must not preventDefault ⌘K on macOS or the menu never sees it.
    expect(
      classifyQuickConnectKey(key("k", { metaKey: true }), true, true),
    ).toBe("menu");
    expect(
      classifyQuickConnectKey(key("k", { metaKey: true }), true, false),
    ).toBe("open");
    expect(
      classifyQuickConnectKey(key("k", { ctrlKey: true }), false, false),
    ).toBe("open");
    expect(
      classifyQuickConnectKey(key("k", { ctrlKey: true }), true, true),
    ).toBeNull();
    expect(
      classifyQuickConnectKey(
        key("k", { ctrlKey: true, shiftKey: true }),
        false,
        false,
      ),
    ).toBeNull();
    expect(
      classifyQuickConnectKey(key("j", { ctrlKey: true }), false, false),
    ).toBeNull();
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
