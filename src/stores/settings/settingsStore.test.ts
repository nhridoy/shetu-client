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

describe("ssh defaults", () => {
  it("initSettings pushes SSH defaults", async () => {
    await useSettingsStore.getState().initSettings();
    expect(mocks.invoke).toHaveBeenCalledWith("set_ssh_defaults", {
      keepaliveSecs: 30,
      connectTimeoutSecs: 10,
      term: "xterm-256color",
    });
  });

  it("updateSetting sshKeepaliveSecs pushes the new value", async () => {
    await useSettingsStore.getState().updateSetting("sshKeepaliveSecs", 60);
    expect(mocks.invoke).toHaveBeenCalledWith("set_ssh_defaults", {
      keepaliveSecs: 60,
      connectTimeoutSecs: 10,
      term: "xterm-256color",
    });
  });

  it("falls back to defaults for junk saved ssh numbers", async () => {
    mocks.entries = [
      ["sshKeepaliveSecs", "abc"],
      ["sshConnectTimeoutSecs", 20],
    ];
    await useSettingsStore.getState().initSettings();
    expect(mocks.invoke).toHaveBeenCalledWith("set_ssh_defaults", {
      keepaliveSecs: 30,
      connectTimeoutSecs: 20,
      term: "xterm-256color",
    });
  });

  it("falls back to the default keepalive for a non-integer saved value", async () => {
    mocks.entries = [
      ["sshKeepaliveSecs", 30.5],
      ["sshConnectTimeoutSecs", 20],
      ["sshTerminalType", "vt100"],
    ];
    await useSettingsStore.getState().initSettings();
    expect(mocks.invoke).toHaveBeenCalledWith("set_ssh_defaults", {
      keepaliveSecs: 30,
      connectTimeoutSecs: 20,
      term: "vt100",
    });
  });

  it("falls back to xterm-256color for an unknown saved terminal type", async () => {
    mocks.entries = [["sshTerminalType", "foo"]];
    await useSettingsStore.getState().initSettings();
    expect(useSettingsStore.getState().settings.sshTerminalType).toBe(
      "xterm-256color",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("set_ssh_defaults", {
      keepaliveSecs: 30,
      connectTimeoutSecs: 10,
      term: "xterm-256color",
    });
  });
});
