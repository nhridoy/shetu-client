// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob } from "@/lib/sftp/transfers";

const actions = vi.hoisted(() => ({
  pauseTransfer: vi.fn(async () => {}),
  resumeTransfer: vi.fn(async () => {}),
  resumeAllTransfers: vi.fn(async () => {}),
  retryTransfer: vi.fn(async () => {}),
  cancelTransfer: vi.fn(async () => {}),
}));
vi.mock("@/lib/sftp/transfers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/transfers")>()),
  ...actions,
}));

import { useSftpStore } from "@/stores/sftp/sftpStore";
import FileTransfer from "./FileTransfer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const job = (id: string, patch: Partial<TransferJob> = {}): TransferJob => ({
  id,
  kind: "download",
  src: {
    path: `/r/${id}.bin`,
    host: { hostId: "h1", host: "example.com", port: 22, username: "me" },
  },
  dest: { path: `/l/${id}.bin`, host: null },
  replace: false,
  partPath: `/l/${id}.bin.x.part`,
  srcSize: 1000,
  srcMtime: 0,
  status: "active",
  transferred: 500,
  attempt: 0,
  nextRetryAt: null,
  waitReason: null,
  error: null,
  createdAt: 0,
  speed: 0,
  ...patch,
});

const roots: Root[] = [];

function render(jobs: TransferJob[]) {
  unmountAll();
  useSftpStore.setState({ transfers: jobs });
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  roots.push(root);
  act(() => root.render(<FileTransfer />));
  return root;
}

function unmountAll() {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
}

const text = () => document.body.textContent ?? "";
const buttons = () =>
  [...document.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  );
const click = (label: string) => {
  const b = [...document.querySelectorAll("button")].find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent) === label,
  );
  if (!b) throw new Error(`no button ${label}`);
  act(() => b.click());
};

beforeEach(() => {
  for (const a of Object.values(actions)) a.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe("FileTransfer panel", () => {
  it("shows the retry countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    render([
      job("a", {
        status: "waiting",
        waitReason: "retry",
        attempt: 2,
        nextRetryAt: 108_000,
      }),
    ]);
    expect(text()).toContain("Retrying in 8 s (2 of 5)");
    act(() => vi.advanceTimersByTime(3000));
    expect(text()).toContain("Retrying in 5 s (2 of 5)");
  });

  it("shows waiting for unlock and for host", () => {
    render([
      job("a", { status: "waiting", waitReason: "unlock" }),
      job("b", { status: "waiting", waitReason: "host" }),
    ]);
    expect(text()).toContain("Waiting for unlock");
    expect(text()).toContain("Waiting for example.com");
  });

  it("shows the file name and status labels", () => {
    render([
      job("q", { status: "queued" }),
      job("p", { status: "paused" }),
      job("f", { status: "failed", error: "denied" }),
      job("d", { status: "done", transferred: 1000 }),
    ]);
    expect(text()).toContain("q.bin");
    expect(text()).toContain("Queued");
    expect(text()).toContain("Paused");
    expect(text()).toContain("denied");
    expect(text()).toContain("Done");
  });

  it("shows per-status buttons", () => {
    render([job("p", { status: "paused" })]);
    expect(buttons()).toEqual(expect.arrayContaining(["Resume", "Cancel"]));
    expect(buttons()).not.toContain("Pause");

    render([job("f", { status: "failed" })]);
    expect(buttons()).toEqual(expect.arrayContaining(["Retry", "Cancel"]));

    render([job("a", { status: "active" })]);
    expect(buttons()).toEqual(expect.arrayContaining(["Pause", "Cancel"]));

    render([job("d", { status: "done" })]);
    expect(buttons()).not.toContain("Cancel");
    expect(buttons()).not.toContain("Pause");
  });

  it("Resume all appears only with a paused job and calls resumeAllTransfers", () => {
    render([job("a", { status: "active" })]);
    expect(buttons()).not.toContain("Resume all");

    render([job("p", { status: "paused" })]);
    click("Resume all");
    expect(actions.resumeAllTransfers).toHaveBeenCalled();
  });

  it("row buttons call the manager", () => {
    render([job("a", { status: "active" })]);
    click("Pause");
    expect(actions.pauseTransfer).toHaveBeenCalledWith("a");
    click("Cancel");
    expect(actions.cancelTransfer).toHaveBeenCalledWith("a");

    render([job("f", { status: "failed" })]);
    click("Retry");
    expect(actions.retryTransfer).toHaveBeenCalledWith("f");

    render([job("p", { status: "paused" })]);
    click("Resume");
    expect(actions.resumeTransfer).toHaveBeenCalledWith("p");
  });
});
