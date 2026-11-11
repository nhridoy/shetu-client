import { describe, expect, it, vi } from "vitest";

const pluginLog = vi.hoisted(() => ({
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-log", () => pluginLog);

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(() => Promise.resolve("/tmp/shetu-logs.txt")),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import {
  formatLogArgs,
  installLogForwarding,
  notifyIfPreviousCrash,
} from "./logging";

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

describe("notifyIfPreviousCrash", () => {
  it("tells the user when exporting from the crash toast fails", async () => {
    invoke.mockImplementation((command: string) =>
      command === "take_crash_marker"
        ? Promise.resolve(true)
        : Promise.reject("disk full"),
    );
    await notifyIfPreviousCrash();
    const [, options] = toast.error.mock.calls[0];
    options.action.onClick();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith(
        "Could not export logs: disk full",
      ),
    );
  });
});
