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
    const items = terminalContextMenuItems(terminal(), vi.fn(), vi.fn());
    expect(item(items, "Copy").disabled).toBe(true);
  });

  it("copies the selection to the clipboard", async () => {
    const term = terminal("hello");
    item(terminalContextMenuItems(term, vi.fn(), vi.fn()), "Copy").onClick();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(term.focus).toHaveBeenCalled();
  });

  it("pastes clipboard text through the terminal input", async () => {
    const term = terminal();
    item(terminalContextMenuItems(term, vi.fn(), vi.fn()), "Paste").onClick();
    await flush();
    expect(term.paste).toHaveBeenCalledWith("ls -la");
  });

  it("selects all, clears, and splits the pane", () => {
    const term = terminal();
    const split = vi.fn();
    const items = terminalContextMenuItems(term, split, vi.fn());
    item(items, "Select All").onClick();
    item(items, "Clear").onClick();
    item(items, "Split Right").onClick();
    item(items, "Split Down").onClick();
    expect(term.selectAll).toHaveBeenCalled();
    expect(term.clear).toHaveBeenCalled();
    expect(split).toHaveBeenNthCalledWith(1, "horizontal");
    expect(split).toHaveBeenNthCalledWith(2, "vertical");
  });

  it("snippets_opens_the_palette in its own group before Clear", () => {
    const openSnippets = vi.fn();
    const items = terminalContextMenuItems(terminal(), vi.fn(), openSnippets);
    const labels = items.map((i) => ("label" in i ? i.label : "|"));
    expect(labels.slice(2, 6)).toEqual(["Select All", "|", "Snippets…", "|"]);
    expect(labels[6]).toBe("Clear");
    item(items, "Snippets…").onClick();
    expect(openSnippets).toHaveBeenCalled();
  });

  it("snippets_shows_the_platform_shortcut", () => {
    const real = navigator.platform;
    const label = (platform: string) => {
      Object.defineProperty(navigator, "platform", {
        value: platform,
        configurable: true,
      });
      const items = terminalContextMenuItems(terminal(), vi.fn(), vi.fn());
      return item(items, "Snippets…").shortcut;
    };
    expect(label("Linux x86_64")).toBe("Ctrl+Shift+P");
    expect(label("MacIntel")).toBe("Cmd+Shift+P");
    Object.defineProperty(navigator, "platform", {
      value: real,
      configurable: true,
    });
  });
});
