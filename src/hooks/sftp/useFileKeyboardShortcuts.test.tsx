// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import type { FileItem } from "@/types/sftp/sftpTypes";
import {
  type UseFileKeyboardShortcutsOptions,
  useFileKeyboardShortcuts,
} from "./useFileKeyboardShortcuts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  useShortcutStore.setState({ overrides: {}, recording: false });
});
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
  document.body.innerHTML = "";
});

function Probe({ opts }: { opts: UseFileKeyboardShortcutsOptions }) {
  useFileKeyboardShortcuts(opts);
  return null;
}

const file = (name: string) => ({ name }) as FileItem;

function setup(over: Partial<UseFileKeyboardShortcutsOptions> = {}) {
  const opts = {
    selectedFiles: new Set(["a"]),
    files: [file("a"), file("b")],
    onCopy: vi.fn(),
    onCut: vi.fn(),
    onPaste: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onRefresh: vi.fn(),
    onNavigateUp: vi.fn(),
    onClearSelection: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onSelectAll: vi.fn(),
    onConfirmDelete: vi.fn(),
    ...over,
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe opts={opts} />));
  const press = (init: KeyboardEventInit, target: Element = document.body) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  return { opts, press };
}

describe("useFileKeyboardShortcuts", () => {
  it("files_copy_uses_mod_c_and_not_while_typing", () => {
    const { opts, press } = setup();
    press({ key: "c", code: "KeyC", ctrlKey: true });
    expect(opts.onCopy).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    press({ key: "c", code: "KeyC", ctrlKey: true }, input);
    expect(opts.onCopy).toHaveBeenCalledTimes(1);
  });

  it("files_new_folder_and_refresh", () => {
    const { opts, press } = setup();
    press({ key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
    press({ key: "F5", code: "F5" });
    expect(opts.onNewFolder).toHaveBeenCalledTimes(1);
    expect(opts.onNewFile).not.toHaveBeenCalled();
    expect(opts.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("files_rename_needs_one_selected", () => {
    const one = setup();
    one.press({ key: "F2", code: "F2" });
    expect(one.opts.onRename).toHaveBeenCalledWith(file("a"));
    const two = setup({ selectedFiles: new Set(["a", "b"]) });
    two.press({ key: "F2", code: "F2" });
    expect(two.opts.onRename).not.toHaveBeenCalled();
  });

  it("files_delete_needs_a_selection", () => {
    const { opts, press } = setup({ selectedFiles: new Set() });
    press({ key: "Delete", code: "Delete" });
    expect(opts.onDelete).not.toHaveBeenCalled();
  });

  it("files_shortcuts_pause_during_delete_confirm", () => {
    const { opts, press } = setup({
      deleteConfirm: { files: [file("a")], selectedNames: null },
    });
    press({ key: "c", code: "KeyC", ctrlKey: true });
    expect(opts.onCopy).not.toHaveBeenCalled();
    press({ key: "Enter", code: "Enter" });
    expect(opts.onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it("files_inactive_pane_ignores_keys", () => {
    const { opts, press } = setup({ activePaneId: "p2", paneId: "p1" });
    press({ key: "c", code: "KeyC", ctrlKey: true });
    expect(opts.onCopy).not.toHaveBeenCalled();
  });

  it("files_follow_a_rebinding", async () => {
    await act(() =>
      useShortcutStore.getState().setBinding("files.refresh", "ctrl+r"),
    );
    const { opts, press } = setup();
    press({ key: "r", code: "KeyR", ctrlKey: true });
    expect(opts.onRefresh).toHaveBeenCalledTimes(1);
    press({ key: "F5", code: "F5" });
    expect(opts.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("escape_still_clears_the_selection", () => {
    const { opts, press } = setup();
    press({ key: "Escape", code: "Escape" });
    expect(opts.onClearSelection).toHaveBeenCalledTimes(1);
  });
});
