// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { liveShortcutIds, runShortcutAction } from "@/lib/shortcuts/actions";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useShortcut } from "./useShortcut";

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
  id,
  cb,
  capture,
}: {
  id: ShortcutId;
  cb: () => void;
  capture?: boolean;
}) {
  useShortcut(id, cb, { capture });
  return null;
}

function setup(id: ShortcutId, capture?: boolean) {
  const cb = vi.fn();
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe id={id} cb={cb} capture={capture} />));
  const press = (init: KeyboardEventInit, target: Element = document.body) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  return { cb, press };
}

describe("useShortcut", () => {
  it("settings_opens_on_ctrl_comma", () => {
    const { cb, press } = setup("app.settings");
    press({ key: ",", code: "Comma", ctrlKey: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("slash_focuses_host_search_but_not_while_typing", () => {
    const { cb, press } = setup("app.searchHosts");
    press({ key: "/", code: "Slash" });
    expect(cb).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    press({ key: "/", code: "Slash" }, input);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("app_shortcut_yields_to_the_active_view", () => {
    useShortcutStore.setState({
      overrides: { "editor.quickOpen": "ctrl+shift+k" },
      activeContext: "editor",
    });
    const { cb, press } = setup("app.quickConnect");
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("capture_runs_before_the_target_swallows_the_key", () => {
    const { cb, press } = setup("app.quickConnect", true);
    const textarea = document.createElement("textarea");
    textarea.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(textarea);
    textarea.focus();
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }, textarea);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

function FindProbe({ cb, enabled }: { cb: () => void; enabled?: boolean }) {
  useShortcut("terminal.find", cb, { enabled });
  return null;
}

describe("useShortcut from the palette", () => {
  function mount(opts: { enabled?: boolean } = {}) {
    const cb = vi.fn();
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<FindProbe cb={cb} enabled={opts.enabled} />));
    return { cb, root };
  }

  it("a palette request runs the handler", () => {
    const { cb, root } = mount();
    expect(runShortcutAction("terminal.find")).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(liveShortcutIds().has("terminal.find")).toBe(false);
  });

  it("a disabled handler is not live", () => {
    const { root } = mount({ enabled: false });
    expect(liveShortcutIds().has("terminal.find")).toBe(false);
    act(() => root.unmount());
  });

  it("an unbound action still runs", () => {
    useShortcutStore.setState({ overrides: { "terminal.find": "" } });
    const { cb, root } = mount();
    expect(runShortcutAction("terminal.find")).toBe(true);
    expect(cb).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("nothing runs while a key is being recorded", () => {
    useShortcutStore.setState({ recording: true });
    const { cb, root } = mount();
    expect(runShortcutAction("terminal.find")).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
