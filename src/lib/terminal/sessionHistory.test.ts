import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, preference } = vi.hoisted(() => ({
  invoke: vi.fn(),
  preference: { recording: false },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: {
    getState: () => ({ vaults: [{ id: "personal-vault", isDefault: true }] }),
  },
}));
vi.mock("@/stores/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { recordTerminalOutput: preference.recording },
    }),
  },
}));
vi.mock("@/stores/sessions/sessionStore", () => ({
  useSessionStore: { setState: vi.fn() },
}));

import {
  beginHistoryAttempt,
  captureHistoryOutput,
  finishHistoryAttempt,
} from "./sessionHistory";

describe("terminal history capture", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    preference.recording = false;
  });

  it("records attempt metadata but no output by default", async () => {
    const attempt = await beginHistoryAttempt("host-1", "Host", "ssh");
    expect(attempt).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith(
      "history_start_attempt",
      expect.objectContaining({ recording: false }),
    );
    await captureHistoryOutput(attempt, "secret");
    expect(invoke).not.toHaveBeenCalledWith(
      "history_append_output",
      expect.anything(),
    );
    await finishHistoryAttempt(attempt, "ended", "pane closed");
  });

  it("captures output only for an attempt opted in at its start", async () => {
    preference.recording = true;
    const attempt = await beginHistoryAttempt("host-1", "Host", "ssh");
    preference.recording = false;
    await captureHistoryOutput(attempt, "output");
    expect(invoke).toHaveBeenCalledWith("history_append_output", {
      attemptId: attempt,
      output: "output",
    });
    await finishHistoryAttempt(attempt, "ended", "pane closed");
  });

  it("finishes only after earlier output has been queued in order", async () => {
    preference.recording = true;
    let releaseFirst: (() => void) | undefined;
    invoke.mockImplementation((command: string, args?: { output?: string }) => {
      if (command === "history_append_output" && args?.output === "first") {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const attempt = await beginHistoryAttempt("h", "Host", "ssh");
    const first = captureHistoryOutput(attempt, "first");
    const second = captureHistoryOutput(attempt, "second");
    const finished = finishHistoryAttempt(attempt, "ended", "pane closed");
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("history_append_output", {
      attemptId: attempt,
      output: "second",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "history_finish_attempt",
      expect.anything(),
    );
    releaseFirst?.();
    await Promise.all([first, second, finished]);
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands.indexOf("history_append_output")).toBeLessThan(
      commands.indexOf("history_finish_attempt"),
    );
    expect(invoke).toHaveBeenCalledWith("history_append_output", {
      attemptId: attempt,
      output: "second",
    });
  });
});
