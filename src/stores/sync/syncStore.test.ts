import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api/sync", () => ({ triggerSync: vi.fn() }));
vi.mock("../../lib/db/db", () => ({ getOutbox: vi.fn(async () => []) }));
const authState = vi.hoisted(() => ({
  localAccessAccountId: "u1",
  isUnlocked: true,
  serverAuthenticated: true,
  retryServerSession: vi.fn(async () => "auth-required"),
}));
vi.mock("../auth/authStore", () => ({
  useAuthStore: { getState: () => authState },
}));
const vaultState = vi.hoisted(() => ({ vaults: [] as { id: string }[] }));
vi.mock("../vault/vaultStore", () => ({
  useVaultStore: { getState: () => vaultState },
}));

import { triggerSync } from "../../lib/api/sync";
import { getOutbox } from "../../lib/db/db";
import { SYNC_COMPLETED_EVENT, useSyncStore } from "./syncStore";

const report = {
  pending: 0,
  last_sync_at: "2026-09-28T00:00:00.000Z",
  cursor: 4,
};

describe("sync scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(getOutbox).mockResolvedValue([]);
    vi.mocked(triggerSync).mockResolvedValue(report);
    vaultState.vaults = [];
    authState.localAccessAccountId = "u1";
    authState.serverAuthenticated = true;
    authState.retryServerSession.mockResolvedValue("auth-required");
    useSyncStore.setState({
      state: "local-only",
      pendingCount: 0,
      lastSyncAt: null,
      error: null,
    });
  });

  it("coalesces repeated edits into one debounced sync", async () => {
    useSyncStore.getState().notifyLocalMutation("v1");
    useSyncStore.getState().notifyLocalMutation("v1");
    await vi.advanceTimersByTimeAsync(800);
    expect(triggerSync).toHaveBeenCalledTimes(1);
  });

  it("keeps per-vault edit timers independent", async () => {
    useSyncStore.getState().notifyLocalMutation("v1");
    useSyncStore.getState().notifyLocalMutation("v2");
    await vi.advanceTimersByTimeAsync(800);
    expect(triggerSync).toHaveBeenCalledWith("v1");
    expect(triggerSync).toHaveBeenCalledWith("v2");
  });

  it("schedules all known vaults when reconnecting", async () => {
    vaultState.vaults = [{ id: "v1" }, { id: "v2" }];
    await useSyncStore.getState().requestAll();
    expect(triggerSync).toHaveBeenCalledWith("v1");
    expect(triggerSync).toHaveBeenCalledWith("v2");
  });

  it("retains pending state on network failure", async () => {
    vi.mocked(getOutbox).mockResolvedValue([
      {
        table_name: "hosts",
        record_id: "h1",
        vault_id: "v1",
        operation_id: "op1",
        device_id: "device1",
        edited_at: "2026-09-28T00:00:00.000Z",
        generation: 1,
        queued_at: "2026-09-28T00:00:00.000Z",
      },
    ]);
    vi.mocked(triggerSync).mockRejectedValue(new Error("network: offline"));
    await useSyncStore.getState().requestSync("v1");
    expect(useSyncStore.getState().state).toBe("offline");
    expect(useSyncStore.getState().pendingCount).toBe(1);
  });

  it("pauses for reauthentication without dropping queued work", async () => {
    authState.serverAuthenticated = false;
    vi.mocked(getOutbox).mockResolvedValue([
      {
        table_name: "hosts",
        record_id: "h1",
        vault_id: "v1",
        operation_id: "op1",
        device_id: "device1",
        edited_at: "2026-09-28T00:00:00.000Z",
        generation: 1,
        queued_at: "2026-09-28T00:00:00.000Z",
      },
    ]);
    await useSyncStore.getState().requestSync("v1");
    expect(triggerSync).not.toHaveBeenCalled();
    expect(useSyncStore.getState().state).toBe("auth-required");
    expect(useSyncStore.getState().pendingCount).toBe(1);
  });

  it("retries the saved session on reconnect and resumes pending sync", async () => {
    authState.serverAuthenticated = false;
    authState.retryServerSession.mockResolvedValue("connected");
    vi.mocked(getOutbox).mockResolvedValue([
      {
        table_name: "hosts",
        record_id: "h1",
        vault_id: "v1",
        operation_id: "op1",
        device_id: "device1",
        edited_at: "2026-09-28T00:00:00.000Z",
        generation: 1,
        queued_at: "2026-09-28T00:00:00.000Z",
      },
    ]);
    await useSyncStore.getState().requestSync("v1");
    expect(authState.retryServerSession).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith("v1");
  });

  it("announces a completed pull so active local stores can refresh", async () => {
    const surface = new EventTarget();
    vi.stubGlobal("window", surface);
    vi.stubGlobal(
      "CustomEvent",
      class<T> extends Event {
        detail: T;
        constructor(name: string, init: { detail: T }) {
          super(name);
          this.detail = init.detail;
        }
      },
    );
    const completed = vi.fn();
    surface.addEventListener(SYNC_COMPLETED_EVENT, completed);
    await useSyncStore.getState().requestSync("v1");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(
      (completed.mock.calls[0][0] as CustomEvent<{ vaultId: string }>).detail
        .vaultId,
    ).toBe("v1");
    vi.unstubAllGlobals();
  });

  it("manual retries serialize one request per vault", async () => {
    let resolve!: (value: typeof report) => void;
    vi.mocked(triggerSync).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const a = useSyncStore.getState().retry("v1");
    const b = useSyncStore.getState().retry("v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    resolve(report);
    await Promise.all([a, b]);
    expect(useSyncStore.getState().state).toBe("synced");
  });
});
