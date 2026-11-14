import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  entries: [] as [string, unknown][],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    entries: async () => mocks.entries,
    set: async () => {},
    save: async () => {},
  }),
}));

import { useSettingsStore } from "./settingsStore";

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.entries = [];
});

describe("terminal recording setting", () => {
  it("starts disabled so terminal output is never recorded without opt-in", () => {
    expect(useSettingsStore.getState().settings.recordTerminalOutput).toBe(
      false,
    );
  });
});

describe("trust new hosts setting", () => {
  it("starts disabled", () => {
    expect(useSettingsStore.getState().settings.trustNewHosts).toBe(false);
  });

  it("pushes the saved value to Rust on init", async () => {
    mocks.entries = [["trustNewHosts", "true"]];
    await useSettingsStore.getState().initSettings();
    expect(useSettingsStore.getState().settings.trustNewHosts).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("set_trust_new_hosts", {
      enabled: true,
    });
  });

  it("pushes changes to Rust", async () => {
    await useSettingsStore.getState().updateSetting("trustNewHosts", false);
    expect(mocks.invoke).toHaveBeenCalledWith("set_trust_new_hosts", {
      enabled: false,
    });
  });
});
