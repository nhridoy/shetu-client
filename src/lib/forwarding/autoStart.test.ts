import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ invoke: vi.fn(async () => 0) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));

import {
  autoStartOnUnlock,
  autoStartWithTerminal,
  resetAutoStartForTests,
} from "./autoStart";

beforeEach(() => {
  m.invoke.mockClear();
  resetAutoStartForTests();
});

describe("forward auto-start triggers", () => {
  it("unlock starts the unlock forwards once per run", async () => {
    await autoStartOnUnlock();
    await autoStartOnUnlock();
    expect(m.invoke).toHaveBeenCalledTimes(1);
    expect(m.invoke).toHaveBeenCalledWith("auto_start_forwards", {
      trigger: "unlock",
    });
  });

  it("a connected terminal starts that host's terminal forwards, every time", async () => {
    await autoStartWithTerminal("h1", "p1");
    await autoStartWithTerminal("h1", "p1");
    expect(m.invoke).toHaveBeenCalledTimes(2);
    expect(m.invoke).toHaveBeenCalledWith("auto_start_forwards", {
      trigger: "terminal",
      hostId: "h1",
      ownerPaneId: "p1",
    });
  });

  it("failures never reach the caller", async () => {
    m.invoke.mockRejectedValueOnce(new Error("locked"));
    await expect(autoStartWithTerminal("h1", "p1")).resolves.toBeUndefined();
  });
});
