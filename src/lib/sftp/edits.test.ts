import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pick: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.pick,
  confirm: mocks.confirm,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { useSettingsStore } from "@/stores/settings/settingsStore";
import { openRemoteFile, type RemoteEdit, stopEditsForSession } from "./edits";

const edit = (id: string, sessionId: string, unsent = false) =>
  ({ id, sessionId, unsent }) as unknown as RemoteEdit;

describe("remote edits", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.pick.mockReset();
    mocks.confirm.mockReset();
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, openWithApps: {} },
    }));
  });

  it("asks before opening a large file and retries confirmed", async () => {
    mocks.invoke
      .mockRejectedValueOnce("large:73400320")
      .mockResolvedValueOnce({ id: "e" });
    mocks.confirm.mockResolvedValueOnce(true);
    await openRemoteFile("pane-1", "/var/log/big.log");
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.stringContaining("big.log is 70.0 MB"),
      expect.anything(),
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith("edit_open", {
      sessionId: "pane-1",
      remotePath: "/var/log/big.log",
      appName: null,
      confirmLarge: true,
    });
  });

  it("does not open a large file when the user declines", async () => {
    mocks.invoke.mockRejectedValueOnce("large:73400320");
    mocks.confirm.mockResolvedValueOnce(false);
    expect(await openRemoteFile("pane-1", "/var/log/big.log")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("Open with… remembers the chosen app per extension and can change it", async () => {
    mocks.invoke.mockResolvedValue({ id: "e" });
    mocks.pick.mockResolvedValueOnce("/usr/bin/code");
    await openRemoteFile("pane-1", "/etc/nginx.conf", { withApp: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "edit_open",
      expect.objectContaining({ appName: "/usr/bin/code" }),
    );
    expect(useSettingsStore.getState().settings.openWithApps).toEqual({
      conf: "/usr/bin/code",
    });
    // Next time the picker opens at the remembered app, and a different pick replaces it.
    mocks.pick.mockResolvedValueOnce("/usr/bin/vim");
    await openRemoteFile("pane-1", "/etc/other.conf", { withApp: true });
    expect(mocks.pick).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: "/usr/bin/code" }),
    );
    expect(useSettingsStore.getState().settings.openWithApps).toEqual({
      conf: "/usr/bin/vim",
    });
    mocks.pick.mockResolvedValueOnce(null);
    expect(
      await openRemoteFile("pane-1", "/etc/x.conf", { withApp: true }),
    ).toBeNull();
  });

  it("closing a pane stops its sent edits and keeps unsent ones", async () => {
    mocks.invoke.mockImplementation(
      async (_cmd: string, args: { id: string }) => {
        if (args.id === "u") throw "unsent";
      },
    );
    await stopEditsForSession("pane-1", [
      edit("a", "pane-1"),
      edit("u", "pane-1", true),
      edit("b", "pane-2"),
    ]);
    expect(mocks.invoke).toHaveBeenCalledWith("edit_stop", {
      id: "a",
      discard: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("edit_stop", {
      id: "u",
      discard: false,
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("edit_stop", {
      id: "b",
      discard: false,
    });
  });
});
