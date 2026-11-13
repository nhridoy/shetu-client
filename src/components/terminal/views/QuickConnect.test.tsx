// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: () => ({ hosts: [] }),
}));
vi.mock("@/stores/terminal/shellStore", () => ({
  useShellStore: (pick: (s: { shells: unknown[] }) => unknown) =>
    pick({ shells: [] }),
}));

import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import QuickConnect from "./QuickConnect";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  useShortcutStore.setState({ overrides: {}, activeContext: null });
});
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
  document.body.innerHTML = "";
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  act(() =>
    createRoot(container).render(<QuickConnect onConnect={() => {}} />),
  );
  const press = (init: KeyboardEventInit) =>
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  const isOpen = () => document.querySelector("input") !== null;
  return { press, isOpen };
}

describe("QuickConnect shortcut", () => {
  it("quick_connect_opens_on_ctrl_shift_k", () => {
    const { press, isOpen } = setup();
    expect(isOpen()).toBe(false);
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(isOpen()).toBe(true);
  });

  it("plain_ctrl_k_no_longer_opens_quick_connect", () => {
    const { press, isOpen } = setup();
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(isOpen()).toBe(false);
  });

  it("quick_connect_follows_a_rebinding", async () => {
    await act(() =>
      useShortcutStore.getState().setBinding("app.quickConnect", "ctrl+alt+k"),
    );
    const { press, isOpen } = setup();
    press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(isOpen()).toBe(true);
  });

  it("quick_connect_leaves_keys_the_editor_handled", () => {
    const { isOpen } = setup();
    // The code editor binds Ctrl+Shift+K to "delete line" and marks the event handled.
    const editor = document.createElement("div");
    editor.addEventListener("keydown", (e) => e.preventDefault());
    document.body.append(editor);
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "K",
          code: "KeyK",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(isOpen()).toBe(false);
  });
});
