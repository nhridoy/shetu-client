import { describe, expect, it, vi } from "vitest";

const pluginLog = vi.hoisted(() => ({
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-log", () => pluginLog);

import { formatLogArgs, installLogForwarding } from "./logging";

describe("formatLogArgs", () => {
  it("joins strings, errors with stack, and objects as JSON", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (app.js:1)";
    expect(formatLogArgs(["Sync failed:", err, { code: 7 }])).toBe(
      'Sync failed: Error: boom\n    at f (app.js:1) {"code":7}',
    );
  });

  it("survives values JSON cannot encode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLogArgs([cyclic, undefined])).toBe(
      "[object Object] undefined",
    );
  });
});

describe("installLogForwarding", () => {
  it("forwards console.error to the log file and still prints it", () => {
    vi.stubGlobal("window", new EventTarget());
    const original = vi.fn();
    console.error = original;
    installLogForwarding();
    console.error("Sync failed:", "network");
    expect(original).toHaveBeenCalledWith("Sync failed:", "network");
    expect(pluginLog.error).toHaveBeenCalledWith("Sync failed: network");
  });
});
