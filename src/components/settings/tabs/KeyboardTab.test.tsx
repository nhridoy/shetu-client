// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import KeyboardTab from "./KeyboardTab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
const setPlatform = (value: string) =>
  Object.defineProperty(navigator, "platform", { value, configurable: true });

beforeEach(() => {
  setPlatform("Linux x86_64");
  useShortcutStore.setState({
    overrides: {},
    activeContext: null,
    recording: false,
  });
});
afterEach(() => {
  setPlatform(realPlatform);
  document.body.innerHTML = "";
});

function NewTabProbe({ onNewTab }: { onNewTab: () => void }) {
  useKeyboardShortcuts({ onNewTab });
  return null;
}

function setup(onNewTab?: () => void) {
  const container = document.createElement("div");
  document.body.append(container);
  act(() =>
    createRoot(container).render(
      <>
        <KeyboardTab />
        {onNewTab && <NewTabProbe onNewTab={onNewTab} />}
      </>,
    ),
  );
  const row = (id: string) =>
    container.querySelector(`[data-shortcut="${id}"]`) as HTMLElement;
  const cap = (id: string) =>
    row(id).querySelector("[data-cap]") as HTMLElement;
  const button = (id: string, text: string) =>
    [...row(id).querySelectorAll("button")].find(
      (b) => b.textContent === text,
    ) as HTMLButtonElement;
  const click = (el: HTMLElement) => act(() => el.click());
  const press = async (init: KeyboardEventInit) => {
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  };
  return { container, row, cap, button, click, press };
}

const overrides = () => useShortcutStore.getState().overrides;

describe("KeyboardTab", () => {
  it("lists_every_shortcut_by_context", () => {
    const { container } = setup();
    for (const h of ["App-wide", "Terminal", "File browser", "Editor"])
      expect(container.textContent).toContain(h);
    expect(container.querySelectorAll("[data-shortcut]")).toHaveLength(30);
  });

  it("records_a_new_binding", async () => {
    const { cap, click, press } = setup();
    click(cap("terminal.newTab"));
    expect(cap("terminal.newTab").textContent).toBe("Press keys…");
    await press({ code: "KeyN", key: "n", altKey: true });
    expect(overrides()["terminal.newTab"]).toBe("alt+n");
    expect(cap("terminal.newTab").textContent).toBe("Alt+N");
  });

  it("recording_does_not_trigger_shortcuts", async () => {
    const onNewTab = vi.fn();
    const { cap, click, press } = setup(onNewTab);
    click(cap("terminal.newTab"));
    await press({ code: "KeyT", key: "T", ctrlKey: true, shiftKey: true });
    expect(onNewTab).not.toHaveBeenCalled();
    expect(useShortcutStore.getState().recording).toBe(false);
    expect(overrides()).toEqual({});
  });

  it("modifier_only_presses_keep_waiting", async () => {
    const { cap, click, press } = setup();
    click(cap("terminal.newTab"));
    await press({ code: "ControlLeft", key: "Control", ctrlKey: true });
    expect(cap("terminal.newTab").textContent).toBe("Press keys…");
  });

  it("escape_cancels_recording", async () => {
    const { cap, click, press } = setup();
    click(cap("terminal.newTab"));
    await press({ code: "Escape", key: "Escape" });
    expect(cap("terminal.newTab").textContent).toBe("Ctrl+Shift+T");
    expect(useShortcutStore.getState().recording).toBe(false);
  });

  it("bare_key_refused_where_typing", async () => {
    const { row, cap, click, press } = setup();
    click(cap("terminal.palette"));
    await press({ code: "KeyP", key: "p" });
    expect(row("terminal.palette").textContent).toContain(
      "Add Ctrl or Alt — this shortcut works while you type.",
    );
    expect(overrides()).toEqual({});
  });

  it("conflict_offers_replace", async () => {
    const { row, cap, button, click, press } = setup();
    click(cap("files.copy"));
    await press({ code: "KeyX", key: "x", ctrlKey: true });
    expect(row("files.copy").textContent).toContain("Already used by Cut.");
    expect(overrides()).toEqual({});
    await act(async () => button("files.copy", "Replace").click());
    expect(overrides()).toEqual({ "files.copy": "ctrl+x", "files.cut": "" });
  });

  it("conflict_cancel_keeps_both", async () => {
    const { row, cap, button, click, press } = setup();
    click(cap("files.copy"));
    await press({ code: "KeyX", key: "x", ctrlKey: true });
    click(button("files.copy", "Cancel"));
    expect(row("files.copy").textContent).not.toContain("Already used");
    expect(overrides()).toEqual({});
  });

  it("shell_key_warns_but_saves", async () => {
    const { row, cap, click, press } = setup();
    click(cap("terminal.palette"));
    await press({ code: "KeyR", key: "r", ctrlKey: true });
    expect(overrides()["terminal.palette"]).toBe("ctrl+r");
    expect(row("terminal.palette").textContent).toContain(
      "The terminal won't receive Ctrl+R.",
    );
  });

  it("shadow_is_noted", async () => {
    const { row, cap, click, press } = setup();
    click(cap("editor.quickOpen"));
    await press({ code: "KeyK", key: "K", ctrlKey: true, shiftKey: true });
    expect(row("editor.quickOpen").textContent).toContain(
      "Overrides Quick Connect in the Editor.",
    );
  });

  it("reset_and_clear", async () => {
    const { container, cap, button } = setup();
    await act(async () => button("terminal.palette", "Clear").click());
    expect(cap("terminal.palette").textContent).toBe("None");
    await act(async () => button("terminal.palette", "Reset").click());
    expect(cap("terminal.palette").textContent).toBe("Ctrl+Shift+P");
    await act(async () => button("files.copy", "Clear").click());
    const resetAll = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reset all",
    ) as HTMLButtonElement;
    await act(async () => resetAll.click());
    expect(overrides()).toEqual({});
  });

  it("mac_copy_paste_rows_are_fixed", () => {
    setPlatform("MacIntel");
    const { row } = setup();
    expect(row("terminal.copy").querySelector("button")).toBeNull();
    expect(row("terminal.copy").textContent).toContain("⌘C");
    expect(row("terminal.copy").textContent).toContain("System");
    expect(row("terminal.paste").textContent).toContain("⌘V");
  });
});
