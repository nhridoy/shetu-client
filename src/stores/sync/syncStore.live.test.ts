import { beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({
  status: null as ((s: "connected" | "disconnected") => void) | null,
  signal: null as ((kind: string) => void) | null,
}));
vi.mock("@/lib/live/live", () => ({
  onLiveStatus: (cb: (s: "connected" | "disconnected") => void) => {
    live.status = cb;
  },
  onLiveSignal: (cb: (kind: string) => void) => {
    live.signal = cb;
  },
}));
vi.mock("../../lib/api/sync", () => ({ triggerSync: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../../lib/db/db", () => ({ getOutbox: vi.fn(async () => []) }));
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({
      localAccessAccountId: "u1",
      isUnlocked: true,
      serverAuthenticated: true,
      retryServerSession: vi.fn(),
    }),
  },
}));
vi.mock("../vault/vaultStore", () => ({
  useVaultStore: { getState: () => ({ vaults: [] }) },
}));

import { invoke } from "@tauri-apps/api/core";
import { triggerSync } from "../../lib/api/sync";
import { useSyncStore } from "./syncStore";

const realRequestAll = useSyncStore.getState().requestAll;

describe("live sync", () => {
  let requestAll: ReturnType<typeof vi.fn>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    requestAll = vi.fn(async () => {});
    useSyncStore.setState({ live: false, requestAll } as never);
    stop = useSyncStore.getState().start("v1");
    requestAll.mockClear();
    return () => stop();
  });

  it("connected switches to 5 minutes and syncs once", async () => {
    live.status?.("connected");
    expect(useSyncStore.getState().live).toBe(true);
    expect(requestAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(requestAll).toHaveBeenCalledTimes(2);
  });

  it("disconnected switches back to 30 seconds", async () => {
    live.status?.("connected");
    live.status?.("disconnected");
    requestAll.mockClear();
    expect(useSyncStore.getState().live).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestAll).toHaveBeenCalledTimes(1);
  });

  it("changed bursts coalesce", async () => {
    let finish!: () => void;
    requestAll.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    for (let i = 0; i < 50; i++) live.signal?.("changed");
    expect(requestAll).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAll).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAll).toHaveBeenCalledTimes(2);
  });

  it("knows the stream was already live when sync starts after an unlock", async () => {
    stop();
    live.status?.("connected");
    stop = useSyncStore.getState().start("v1");
    requestAll.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestAll).toHaveBeenCalledTimes(0);
  });

  it("a change during an in-flight sync gets a fresh pull after it", async () => {
    stop();
    let finish!: (v: unknown) => void;
    vi.mocked(triggerSync)
      .mockReturnValueOnce(
        new Promise((r) => {
          finish = r;
        }) as never,
      )
      .mockResolvedValue({
        pending: 0,
        last_sync_at: null,
        cursor: 1,
      } as never);
    useSyncStore.setState({ requestAll: realRequestAll } as never);
    stop = useSyncStore.getState().start("v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    // The pull in flight may already have read the server: the signal needs its own.
    live.signal?.("changed");
    finish({ pending: 0, last_sync_at: null, cursor: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(triggerSync).toHaveBeenCalledTimes(2);
  });

  it("queued signal work stops with the scheduler", async () => {
    let finish!: () => void;
    requestAll.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    live.signal?.("changed");
    live.signal?.("changed");
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAll).toHaveBeenCalledTimes(1);
  });

  it("a signal waiting on an in-flight sync does nothing once stopped", async () => {
    stop();
    let finish!: (v: unknown) => void;
    vi.mocked(triggerSync)
      .mockReset()
      .mockReturnValueOnce(
        new Promise((r) => {
          finish = r;
        }) as never,
      )
      .mockResolvedValue({
        pending: 0,
        last_sync_at: null,
        cursor: 1,
      } as never);
    const spy = vi.fn(realRequestAll);
    useSyncStore.setState({ requestAll: spy } as never);
    stop = useSyncStore.getState().start("v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    live.signal?.("changed");
    stop();
    finish({ pending: 0, last_sync_at: null, cursor: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a change during a team sync gets a fresh team sync after it", async () => {
    stop();
    vi.mocked(triggerSync)
      .mockReset()
      .mockResolvedValue({
        pending: 0,
        last_sync_at: null,
        cursor: 1,
      } as never);
    let finishTeam!: (v: unknown) => void;
    vi.mocked(invoke)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishTeam = r;
          }) as never,
      )
      .mockResolvedValue({} as never);
    useSyncStore.setState({ requestAll: realRequestAll } as never);
    stop = useSyncStore.getState().start("v1");
    await vi.advanceTimersByTimeAsync(0);
    const teamSyncs = () =>
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "team_sync_now")
        .length;
    expect(teamSyncs()).toBe(1);
    live.signal?.("changed");
    // Let the signal's pass run while the first team sync is still going.
    await vi.advanceTimersByTimeAsync(0);
    finishTeam({});
    await vi.advanceTimersByTimeAsync(0);
    expect(teamSyncs()).toBe(2);
  });
});
