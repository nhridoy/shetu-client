import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob } from "@/lib/sftp/transfers";

const mocks = vi.hoisted(() => ({
  listTransfers: vi.fn(),
  clearFinishedTransfers: vi.fn(async () => {}),
  resumeAllTransfers: vi.fn(async () => {}),
  onTransfersChanged: vi.fn(async () => () => {}),
  onTransfersReset: vi.fn(async (_cb: () => void) => () => {}),
  toast: vi.fn(),
}));
vi.mock("@/lib/sftp/transfers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/transfers")>()),
  listTransfers: mocks.listTransfers,
  clearFinishedTransfers: mocks.clearFinishedTransfers,
  resumeAllTransfers: mocks.resumeAllTransfers,
  onTransfersChanged: mocks.onTransfersChanged,
  onTransfersReset: mocks.onTransfersReset,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const job = (id: string, patch: Partial<TransferJob> = {}): TransferJob => ({
  id,
  kind: "upload",
  src: { path: `/l/${id}`, host: null },
  dest: { path: `/r/${id}`, host: null },
  replace: false,
  partPath: `/r/${id}.x.part`,
  srcSize: 10,
  srcMtime: 0,
  status: "queued",
  transferred: 0,
  attempt: 0,
  nextRetryAt: null,
  waitReason: null,
  error: null,
  createdAt: 0,
  speed: 0,
  ...patch,
});

describe("sftpStore transfers mirror", () => {
  let useSftpStore: typeof import("./sftpStore").useSftpStore;

  beforeEach(async () => {
    vi.resetModules();
    for (const m of Object.values(mocks)) m.mockClear();
    useSftpStore = (await import("./sftpStore")).useSftpStore;
  });

  it("mirrors changed jobs by id", () => {
    const { applyTransferChanges } = useSftpStore.getState();
    applyTransferChanges([job("a"), job("b")]);
    applyTransferChanges([job("a", { status: "active", transferred: 5 })]);
    const t = useSftpStore.getState().transfers;
    expect(t.map((j) => j.id)).toEqual(["a", "b"]);
    expect(t[0]).toMatchObject({ status: "active", transferred: 5 });
  });

  it("shows one paused toast with Resume all on first load", async () => {
    mocks.listTransfers.mockResolvedValue([
      job("a", { status: "paused" }),
      job("b", { status: "paused" }),
      job("c", { status: "failed" }),
    ]);
    await useSftpStore.getState().ensureTransferListener();
    await useSftpStore.getState().ensureTransferListener();
    expect(useSftpStore.getState().transfers).toHaveLength(3);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [text, opts] = mocks.toast.mock.calls[0] as unknown as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(text).toBe("2 transfers paused");
    expect(opts.action.label).toBe("Resume all");
    opts.action.onClick();
    expect(mocks.resumeAllTransfers).toHaveBeenCalled();
  });

  it("says 1 transfer paused for a single job and nothing when none", async () => {
    mocks.listTransfers.mockResolvedValue([job("a", { status: "paused" })]);
    await useSftpStore.getState().ensureTransferListener();
    expect(mocks.toast.mock.calls[0][0]).toBe("1 transfer paused");
  });

  it("empties the mirror when the queue is wiped", async () => {
    mocks.listTransfers.mockResolvedValue([job("a")]);
    await useSftpStore.getState().ensureTransferListener();
    expect(useSftpStore.getState().transfers).toHaveLength(1);
    const reset = mocks.onTransfersReset.mock.calls[0][0];
    reset();
    expect(useSftpStore.getState().transfers).toEqual([]);
  });

  it("clearCompletedTransfers keeps unfinished jobs", async () => {
    useSftpStore
      .getState()
      .applyTransferChanges([
        job("d", { status: "done" }),
        job("c", { status: "cancelled" }),
        job("f", { status: "failed" }),
        job("p", { status: "paused" }),
      ]);
    await useSftpStore.getState().clearCompletedTransfers();
    expect(mocks.clearFinishedTransfers).toHaveBeenCalled();
    expect(useSftpStore.getState().transfers.map((j) => j.id)).toEqual([
      "f",
      "p",
    ]);
  });
});
