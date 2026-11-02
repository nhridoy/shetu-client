import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import { terminalContextMenuItems } from "./terminalContextMenu";

function terminal(selection = "") {
  return {
    hasSelection: vi.fn(() => selection !== ""),
    getSelection: vi.fn(() => selection),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
  };
}

function item(items: ContextMenuItem[], label: string) {
  const found = items.find((i) => "label" in i && i.label === label);
  if (!found || !("label" in found)) throw new Error(`no ${label} item`);
  return found;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  clipboard.readText.mockResolvedValue("ls -la");
  clipboard.writeText.mockResolvedValue(undefined);
});

describe("terminalContextMenuItems", () => {
  it("disables Copy without a selection", () => {
    const items = terminalContextMenuItems(terminal(), vi.fn());
    expect(item(items, "Copy").disabled).toBe(true);
  });

  it("copies the selection to the clipboard", async () => {
    const term = terminal("hello");
    item(terminalContextMenuItems(term, vi.fn()), "Copy").onClick();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(term.focus).toHaveBeenCalled();
  });

  it("pastes clipboard text through the terminal input", async () => {
    const term = terminal();
    item(terminalContextMenuItems(term, vi.fn()), "Paste").onClick();
    await flush();
    expect(term.paste).toHaveBeenCalledWith("ls -la");
  });

  it("selects all, clears, and splits the pane", () => {
    const term = terminal();
    const split = vi.fn();
    const items = terminalContextMenuItems(term, split);
    item(items, "Select All").onClick();
    item(items, "Clear").onClick();
    item(items, "Split Right").onClick();
    item(items, "Split Down").onClick();
    expect(term.selectAll).toHaveBeenCalled();
    expect(term.clear).toHaveBeenCalled();
    expect(split).toHaveBeenNthCalledWith(1, "horizontal");
    expect(split).toHaveBeenNthCalledWith(2, "vertical");
  });
});
