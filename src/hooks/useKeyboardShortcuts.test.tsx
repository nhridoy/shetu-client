// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
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
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  const handlers = {
    onNextTab: vi.fn(),
    onPrevTab: vi.fn(),
    onSplitHorizontal: vi.fn(),
    onSplitVertical: vi.fn(),
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe handlers={handlers} />));
  const press = (init: KeyboardEventInit) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
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
    press({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(handlers.onPrevTab).toHaveBeenCalledTimes(1);
    expect(handlers.onNextTab).not.toHaveBeenCalled();
  });

  it("ctrl_tab_goes_forward_one_tab", () => {
    const { handlers, press } = setup();
    press({ key: "Tab", ctrlKey: true });
    expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevTab).not.toHaveBeenCalled();
  });
});
