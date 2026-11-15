import { describe, expect, it, vi } from "vitest";
import {
  liveShortcutIds,
  registerShortcutHandler,
  runShortcutAction,
} from "./actions";

describe("shortcut actions", () => {
  it("runs a live handler and forgets it once disposed", () => {
    const fn = vi.fn();
    const dispose = registerShortcutHandler("terminal.find", fn);
    expect(liveShortcutIds().has("terminal.find")).toBe(true);
    expect(runShortcutAction("terminal.find")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    dispose();
    expect(liveShortcutIds().has("terminal.find")).toBe(false);
    expect(runShortcutAction("terminal.find")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stays live until every handler of the id is gone", () => {
    const a = registerShortcutHandler("app.settings", () => {});
    const b = registerShortcutHandler("app.settings", () => {});
    a();
    expect(liveShortcutIds().has("app.settings")).toBe(true);
    b();
    expect(liveShortcutIds().has("app.settings")).toBe(false);
  });
});
