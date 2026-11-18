import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob } from "@/lib/sftp/transfers";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";
import {
  type FileProvider,
  parentPath,
  resolveTransferPaths,
  transferFiles,
} from "./fileTransfer";

const mkdir = (name: string, path: string): FileItem => ({
  name,
  path,
  type: "directory",
  size: 0,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
});

const mkfile = (name: string, path: string): FileItem => ({
  name,
  path,
  type: "file",
  size: 1,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
});

type Override = {
  action: "replace" | "rename" | "auto" | "skip";
  newName?: string;
};

describe("resolveTransferPaths", () => {
  // Real expansion order in transferFiles: children are listed before the
  // directory entry itself is pushed. Tests must mirror that (children first).
  const folderWithChildren = (name: string, root: string) => [
    {
      file: mkfile("a.txt", `${root}/${name}/a.txt`),
      relativePath: `${name}/a.txt`,
    },
    {
      file: mkfile("b.txt", `${root}/${name}/b.txt`),
      relativePath: `${name}/b.txt`,
    },
    { file: mkdir(name, `${root}/${name}`), relativePath: name },
  ];

  it("auto-renames a conflicting folder and remaps all children", () => {
    const items = folderWithChildren("docs", "/src");
    const overrides = new Map<string, Override>([
      ["/src/docs", { action: "auto" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["docs"]),
    );

    expect(resolved.map((r) => r.relativePath)).toEqual([
      "docs (copy)/a.txt",
      "docs (copy)/b.txt",
      "docs (copy)",
    ]);
    expect(
      resolved.find((r) => r.file.path === "/src/docs/a.txt")?.destFilePath,
    ).toBe("/dest/docs (copy)/a.txt");
  });

  it("renames a folder to the user-provided name and remaps children", () => {
    const items = folderWithChildren("docs", "/src");
    const overrides = new Map<string, Override>([
      ["/src/docs", { action: "rename", newName: "docs-v2" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["docs"]),
    );

    expect(resolved.map((r) => r.relativePath)).toEqual([
      "docs-v2/a.txt",
      "docs-v2/b.txt",
      "docs-v2",
    ]);
  });

  it("replaces (keeps name, merges) a conflicting folder", () => {
    const items = folderWithChildren("docs", "/src");
    const overrides = new Map<string, Override>([
      ["/src/docs", { action: "replace" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["docs"]),
    );

    expect(resolved.map((r) => r.relativePath)).toEqual([
      "docs/a.txt",
      "docs/b.txt",
      "docs",
    ]);
  });

  it("skips a conflicting folder and all of its children", () => {
    const items = [
      ...folderWithChildren("docs", "/src"),
      { file: mkfile("top.txt", "/src/top.txt"), relativePath: "top.txt" },
    ];
    const overrides = new Map<string, Override>([
      ["/src/docs", { action: "skip" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["docs"]),
    );

    expect(resolved[0].skip).toBe(true);
    expect(resolved[1].skip).toBe(true);
    expect(resolved[2].skip).toBe(true);
    expect(resolved[3].skip).toBe(false);
    expect(resolved[3].destFilePath).toBe("/dest/top.txt");
  });

  it("auto-renames a conflicting root file on copy (no override)", () => {
    const items = [
      { file: mkfile("a.txt", "/src/a.txt"), relativePath: "a.txt" },
    ];

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      undefined,
      new Set(["a.txt"]),
    );

    expect(resolved[0].destFilePath).toBe("/dest/a (copy).txt");
  });

  it("honors auto override for a root file", () => {
    const items = [
      { file: mkfile("a.txt", "/src/a.txt"), relativePath: "a.txt" },
    ];
    const overrides = new Map<string, Override>([
      ["/src/a.txt", { action: "auto" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["a.txt", "a (copy).txt"]),
    );

    expect(resolved[0].destFilePath).toBe("/dest/a (copy 2).txt");
  });

  it("replaces (keeps name) when override says replace", () => {
    const items = [
      { file: mkfile("a.txt", "/src/a.txt"), relativePath: "a.txt" },
    ];
    const overrides = new Map<string, Override>([
      ["/src/a.txt", { action: "replace" }],
    ]);

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      overrides,
      new Set(["a.txt"]),
    );

    expect(resolved[0].destFilePath).toBe("/dest/a.txt");
  });

  it("keeps folder name on move into existing folder (merge semantics)", () => {
    const items = folderWithChildren("docs", "/src");

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "move",
      undefined,
      new Set(["docs"]),
    );

    expect(resolved[2].relativePath).toBe("docs");
    expect(resolved[0].destFilePath).toBe("/dest/docs/a.txt");
  });

  it("leaves subdirectory files untouched when no root conflict exists", () => {
    const items = folderWithChildren("docs", "/src");

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      undefined,
      new Set(["unrelated.txt"]),
    );

    expect(resolved[2].relativePath).toBe("docs");
    expect(resolved[0].destFilePath).toBe("/dest/docs/a.txt");
  });
});

describe("parentPath", () => {
  it("returns the parent directory for posix paths", () => {
    expect(parentPath("/work/src/a.ts")).toBe("/work/src");
    expect(parentPath("/work/a.ts")).toBe("/work");
    expect(parentPath("/a.txt")).toBe("/");
  });

  it("returns the parent directory for windows paths", () => {
    expect(parentPath("C:\\work\\src\\a.ts")).toBe("C:\\work\\src");
    expect(parentPath("C:\\a.txt")).toBe("C:\\");
  });

  it("returns root for a bare root path", () => {
    expect(parentPath("/")).toBe("/");
  });
});

const transferMocks = vi.hoisted(() => ({
  enqueueTransfers: vi.fn(),
  onTransfersChanged: vi.fn(async () => () => {}),
  onTransfersReset: vi.fn(async () => () => {}),
  listTransfers: vi.fn(async () => []),
}));
vi.mock("@/lib/sftp/transfers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/transfers")>()),
  enqueueTransfers: transferMocks.enqueueTransfers,
  onTransfersChanged: transferMocks.onTransfersChanged,
  onTransfersReset: transferMocks.onTransfersReset,
  listTransfers: transferMocks.listTransfers,
}));

describe("transferFiles with the transfer manager", () => {
  const job = (id: string, patch: Partial<TransferJob> = {}): TransferJob => ({
    id,
    kind: "download",
    src: { path: `/r/${id}`, host: null },
    dest: { path: `/l/${id}`, host: null },
    replace: false,
    partPath: `/l/${id}.x.part`,
    srcSize: 1,
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

  const remote = {
    type: "remote" as const,
    id: "pane-1",
    getSessionId: () => "sess-1",
    listFiles: vi.fn(async () => [mkfile("a.txt", "/l/a.txt")]),
    listFilesRecursive: vi.fn(async () => []),
    isDirectory: vi.fn(async () => false),
  } as unknown as FileProvider;
  const local = {
    type: "local" as const,
    id: "local",
    listFiles: vi.fn(async () => [mkfile("a.txt", "/l/a.txt")]),
    mkdirAll: vi.fn(async () => {}),
  } as unknown as FileProvider;

  const files = [mkfile("a.txt", "/r/a.txt"), mkfile("b.txt", "/r/b.txt")];

  beforeEach(() => {
    useSftpStore.setState({ transfers: [] });
    transferMocks.enqueueTransfers.mockReset();
    transferMocks.enqueueTransfers.mockImplementation(async () => {
      const jobs = [job("j1"), job("j2")];
      useSftpStore.getState().applyTransferChanges(jobs);
      return jobs;
    });
  });

  const start = () =>
    transferFiles({
      source: remote,
      dest: local,
      files,
      destPath: "/l",
      mode: "copy",
      overrides: new Map([["/r/a.txt", { action: "replace" as const }]]),
    });

  const settle = async (patches: Record<string, Partial<TransferJob>>) => {
    await vi.waitFor(() =>
      expect(transferMocks.enqueueTransfers).toHaveBeenCalled(),
    );
    useSftpStore
      .getState()
      .applyTransferChanges(
        Object.entries(patches).map(([id, p]) => job(id, p)),
      );
  };

  it("enqueues every remote file in one call with replace flags", async () => {
    const run = start();
    await settle({ j1: { status: "done" }, j2: { status: "done" } });
    await run;
    expect(transferMocks.enqueueTransfers).toHaveBeenCalledTimes(1);
    expect(transferMocks.enqueueTransfers).toHaveBeenCalledWith([
      {
        kind: "download",
        srcPath: "/r/a.txt",
        destPath: "/l/a.txt",
        srcSessionId: "sess-1",
        destSessionId: undefined,
        replace: true,
      },
      {
        kind: "download",
        srcPath: "/r/b.txt",
        destPath: "/l/b.txt",
        srcSessionId: "sess-1",
        destSessionId: undefined,
        replace: false,
      },
    ]);
  });

  it("resolves when jobs finish", async () => {
    const run = start();
    await settle({ j1: { status: "done" }, j2: { status: "done" } });
    const results = await run;
    expect(results.map((r) => r.action)).toEqual(["copied", "copied"]);
  });

  it("resolves_when_job_paused", async () => {
    const run = start();
    await settle({ j1: { status: "done" }, j2: { status: "paused" } });
    const results = await run;
    expect(results.map((r) => r.action)).toEqual(["copied", "waiting"]);
  });

  it("treats_host_wait_as_handed_off", async () => {
    const run = start();
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });
    await settle({
      j1: { status: "done" },
      j2: { status: "waiting", waitReason: "retry" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    useSftpStore
      .getState()
      .applyTransferChanges([
        job("j2", { status: "waiting", waitReason: "host" }),
      ]);
    const results = await run;
    expect(results[1].action).toBe("waiting");
  });

  it("settles waiters as cancelled when the queue is wiped", async () => {
    const run = start();
    await settle({ j1: { status: "done" } });
    useSftpStore.getState().resetTransfers();
    const results = await run;
    expect(results[1].error).toBe("Cancelled");
  });

  it("renames within the same remote pane instead of copying", async () => {
    const moveFile = vi.fn(async () => {});
    const mkdirAll = vi.fn(async () => {});
    const pane = {
      ...remote,
      listFiles: vi.fn(async () => []),
      listFilesRecursive: vi.fn(async () => {
        throw new Error("a rename doesn't need a listing");
      }),
      moveFile,
      mkdirAll,
    } as unknown as FileProvider;
    const results = await transferFiles({
      source: pane,
      dest: pane,
      files: [mkfile("a.txt", "/r/a.txt"), mkdir("d", "/r/d")],
      destPath: "/r/sub",
      mode: "move",
    });
    expect(moveFile).toHaveBeenCalledWith("/r/a.txt", "/r/sub/a.txt");
    expect(moveFile).toHaveBeenCalledWith("/r/d", "/r/sub/d");
    expect(mkdirAll).not.toHaveBeenCalled();
    expect(transferMocks.enqueueTransfers).not.toHaveBeenCalled();
    expect(results.map((r) => r.action)).toEqual(["moved", "moved"]);
  });

  it("replaces an existing file when moving within one remote pane", async () => {
    const calls: string[] = [];
    const pane = {
      ...remote,
      listFiles: vi.fn(async () => [mkfile("a.txt", "/r/sub/a.txt")]),
      removeFile: vi.fn(async (p: string) => {
        calls.push(`rm ${p}`);
      }),
      moveFile: vi.fn(async (from: string, to: string) => {
        calls.push(`mv ${from} ${to}`);
      }),
    } as unknown as FileProvider;
    const results = await transferFiles({
      source: pane,
      dest: pane,
      files: [mkfile("a.txt", "/r/a.txt")],
      destPath: "/r/sub",
      mode: "move",
      overrides: new Map([["/r/a.txt", { action: "replace" as const }]]),
    });
    expect(calls).toEqual(["rm /r/sub/a.txt", "mv /r/a.txt /r/sub/a.txt"]);
    expect(results[0]).toEqual({
      file: expect.objectContaining({ path: "/r/a.txt" }),
      action: "moved",
    });
  });

  it("reports failed jobs as errors", async () => {
    const run = start();
    await settle({
      j1: { status: "done" },
      j2: { status: "failed", error: "denied" },
    });
    const results = await run;
    expect(results[1].error).toBe("denied");
  });
});

describe("transferFiles without a transfer listener", () => {
  it("fails instead of waiting forever", async () => {
    vi.resetModules();
    const transfers = await import("@/lib/sftp/transfers");
    vi.mocked(transfers.onTransfersChanged).mockRejectedValueOnce(
      new Error("no IPC"),
    );
    const { transferFiles: fresh } = await import("./fileTransfer");
    const enqueue = vi.mocked(transfers.enqueueTransfers);
    enqueue.mockClear();
    const remote = {
      type: "remote" as const,
      id: "pane-1",
      getSessionId: () => "sess-1",
      listFiles: vi.fn(async () => []),
      listFilesRecursive: vi.fn(async () => []),
    } as unknown as FileProvider;
    const local = {
      type: "local" as const,
      id: "local",
      listFiles: vi.fn(async () => []),
      mkdirAll: vi.fn(async () => {}),
    } as unknown as FileProvider;
    await expect(
      fresh({
        source: remote,
        dest: local,
        files: [mkfile("a.txt", "/r/a.txt")],
        destPath: "/l",
        mode: "copy",
      }),
    ).rejects.toThrow("transfer queue");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
