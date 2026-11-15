// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { onOpenFind, openFind } from "./findCommand";

describe("findCommand", () => {
  it("openFind reaches subscribers until they unsubscribe", () => {
    const handler = vi.fn();
    const off = onOpenFind(handler);
    openFind();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    openFind();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("findOpensHere", () => {
  it("only the active pane of the shown tab opens find", async () => {
    const { useTerminalStore } = await import(
      "@/stores/terminal/terminalStore"
    );
    const { findOpensHere } = await import("./findCommand");
    useTerminalStore.setState({ activeTabId: "t1" });
    expect(findOpensHere("t1", true)).toBe(true);
    expect(findOpensHere("t1", false)).toBe(false);
    // Hidden tabs stay mounted with their own active pane.
    expect(findOpensHere("t2", true)).toBe(false);
  });
});
