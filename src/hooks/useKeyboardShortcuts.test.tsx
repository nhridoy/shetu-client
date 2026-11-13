// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  useShortcutStore.setState({
    overrides: {},
    activeContext: null,
    recording: false,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
  document.body.innerHTML = "";
});

function Probe({
  handlers,
}: {
  handlers: Parameters<typeof useKeyboardShortcuts>[0];
}) {
  useKeyboardShortcuts(handlers);
  return null;
}

function setup() {
  const handlers = {
    onNewTab: vi.fn(),
    onNextTab: vi.fn(),
    onPrevTab: vi.fn(),
    onSplitHorizontal: vi.fn(),
    onSplitVertical: vi.fn(),
    onCommandPalette: vi.fn(),
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe handlers={handlers} />));
  const press = (init: KeyboardEventInit, target: Element = document.body) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  return { handlers, press, root };
}

describe("useKeyboardShortcuts", () => {
  it("ctrl_backslash_splits_right_only", () => {
    const { handlers, press } = setup();
    press({ key: "\\", code: "Backslash", ctrlKey: true });
    expect(handlers.onSplitHorizontal).toHaveBeenCalledTimes(1);
    expect(handlers.onSplitVertical).not.toHaveBeenCalled();
  });

  it("ctrl_shift_backslash_splits_down_only", () => {
    const { handlers, press } = setup();
    // US layouts report "|" for Shift+\; others may still say "\".
    press({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true });
    press({ key: "\\", code: "Backslash", ctrlKey: true, shiftKey: true });
    expect(handlers.onSplitVertical).toHaveBeenCalledTimes(2);
    expect(handlers.onSplitHorizontal).not.toHaveBeenCalled();
  });

  it("ctrl_shift_tab_goes_back_one_tab", () => {
    const { handlers, press } = setup();
    press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(handlers.onPrevTab).toHaveBeenCalledTimes(1);
    expect(handlers.onNextTab).not.toHaveBeenCalled();
  });

  it("ctrl_tab_goes_forward_one_tab", () => {
    const { handlers, press } = setup();
    press({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevTab).not.toHaveBeenCalled();
  });

  it("new_tab_is_ctrl_shift_t", () => {
    const { handlers, press } = setup();
    press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    expect(handlers.onNewTab).toHaveBeenCalledTimes(1);
  });

  it("plain_ctrl_t_is_left_to_the_shell", () => {
    const { handlers, press } = setup();
    press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(handlers.onNewTab).not.toHaveBeenCalled();
  });

  it("rebinding_applies_immediately", async () => {
    const { handlers, press } = setup();
    await act(() =>
      useShortcutStore.getState().setBinding("terminal.newTab", "alt+n"),
    );
    press({ key: "n", code: "KeyN", altKey: true });
    press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    expect(handlers.onNewTab).toHaveBeenCalledTimes(1);
  });

  it("fires_while_typing_in_the_terminal", () => {
    const { handlers, press } = setup();
    // xterm's input is a textarea.
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    press({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }, textarea);
    expect(handlers.onCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("empty_binding_never_fires", async () => {
    const { handlers, press } = setup();
    await act(() =>
      useShortcutStore.getState().setBinding("terminal.splitRight", ""),
    );
    press({ key: "\\", code: "Backslash", ctrlKey: true });
    expect(handlers.onSplitHorizontal).not.toHaveBeenCalled();
  });
});
