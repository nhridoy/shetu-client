import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  installationKind: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  close: vi.fn(),
  openReleasePage: vi.fn(),
}));

vi.mock("@/lib/update/updateService", () => ({
  RELEASE_URL: "https://github.com/nhridoy/terra/releases/latest",
  updateService: service,
}));

import { useUpdateStore } from "./updateStore";

const update = {
  version: "1.1.0",
  body: "Fixes",
  date: "2026-10-02T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  service.installationKind.mockResolvedValue("native");
  service.check.mockResolvedValue(null);
  service.download.mockResolvedValue(undefined);
  service.install.mockResolvedValue(undefined);
  service.relaunch.mockResolvedValue(undefined);
  service.close.mockResolvedValue(undefined);
  useUpdateStore.setState({
    status: "idle",
    installationKind: null,
    updateInfo: null,
    downloadProgress: null,
    error: null,
    promptDismissed: false,
  });
});

describe("updateStore", () => {
  it("reports current version on a manual check", async () => {
    await useUpdateStore.getState().checkForUpdates(true);
    expect(useUpdateStore.getState().status).toBe("current");
    expect(service.check).toHaveBeenCalledTimes(1);
  });

  it("offers a newer release with metadata", async () => {
    service.check.mockResolvedValue(update);
    await useUpdateStore.getState().checkForUpdates(false);
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      updateInfo: { version: "1.1.0", notes: "Fixes" },
    });
  });

  it("keeps automatic check errors quiet and allows a manual retry", async () => {
    service.check.mockRejectedValueOnce(new Error("offline"));
    await useUpdateStore.getState().checkForUpdates(false);
    expect(useUpdateStore.getState()).toMatchObject({
      status: "idle",
      error: null,
    });
    service.check.mockRejectedValueOnce(new Error("bad manifest"));
    await useUpdateStore.getState().checkForUpdates(true);
    expect(useUpdateStore.getState()).toMatchObject({
      status: "error",
      error: "bad manifest",
    });
    await useUpdateStore.getState().checkForUpdates(true);
    expect(useUpdateStore.getState()).toMatchObject({
      status: "current",
      error: null,
    });
  });

  it("skips native checks in development", async () => {
    service.installationKind.mockResolvedValue("development");
    await useUpdateStore.getState().checkForUpdates(true);
    expect(useUpdateStore.getState().status).toBe("development");
    expect(service.check).not.toHaveBeenCalled();
  });

  it("opens the release page instead of downloading on package installs", async () => {
    service.installationKind.mockResolvedValue("package");
    service.check.mockResolvedValue(update);
    await useUpdateStore.getState().checkForUpdates(true);
    await useUpdateStore.getState().downloadUpdate();
    expect(service.download).not.toHaveBeenCalled();
    expect(service.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it("tracks download progress and installs only after a verified download", async () => {
    service.check.mockResolvedValue(update);
    service.download.mockImplementation(async (_handle, onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      expect(useUpdateStore.getState().downloadProgress).toBe(40);
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
    });
    await useUpdateStore.getState().checkForUpdates(true);
    await useUpdateStore.getState().downloadUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "ready",
      downloadProgress: 100,
    });
    await useUpdateStore.getState().installUpdate();
    expect(service.install).toHaveBeenCalledWith(update);
  });

  it("blocks duplicate downloads and leaves an error retryable", async () => {
    service.check.mockResolvedValue(update);
    await useUpdateStore.getState().checkForUpdates(true);
    let rejectDownload: (reason?: unknown) => void = () => {};
    service.download.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectDownload = reject;
      }),
    );
    const first = useUpdateStore.getState().downloadUpdate();
    await useUpdateStore.getState().downloadUpdate();
    expect(service.download).toHaveBeenCalledTimes(1);
    rejectDownload(new Error("interrupted"));
    await first;
    expect(useUpdateStore.getState()).toMatchObject({
      status: "available",
      error: "interrupted",
    });
    await useUpdateStore.getState().downloadUpdate();
    expect(useUpdateStore.getState().status).toBe("ready");
  });

  it("keeps a downloaded update ready after install failure", async () => {
    service.check.mockResolvedValue(update);
    service.install.mockRejectedValueOnce(new Error("installer failed"));
    await useUpdateStore.getState().checkForUpdates(true);
    await useUpdateStore.getState().downloadUpdate();
    await useUpdateStore.getState().installUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "ready",
      error: "installer failed",
    });
    await useUpdateStore.getState().installUpdate();
    expect(service.install).toHaveBeenCalledTimes(2);
  });

  it("does not start a second check while the first is pending", async () => {
    let finish: (value: unknown) => void = () => {};
    service.check.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = useUpdateStore.getState().checkForUpdates(true);
    await Promise.resolve();
    await useUpdateStore.getState().checkForUpdates(true);
    expect(service.check).toHaveBeenCalledTimes(1);
    finish(null);
    await first;
  });

  it("retries a failed relaunch without reinstalling an already installed update", async () => {
    service.check.mockResolvedValue(update);
    service.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    await useUpdateStore.getState().checkForUpdates(true);
    await useUpdateStore.getState().downloadUpdate();
    await useUpdateStore.getState().installUpdate();
    expect(useUpdateStore.getState()).toMatchObject({
      status: "restart_required",
      error: "restart failed",
    });
    await useUpdateStore.getState().restartApp();
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(service.relaunch).toHaveBeenCalledTimes(2);
  });
});
