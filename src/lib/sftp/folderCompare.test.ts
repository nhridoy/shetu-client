import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transferFiles: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/sftp/fileTransfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/fileTransfer")>()),
  transferFiles: mocks.transferFiles,
}));

import type { CompareRow } from "./compareFolders";
import type { FileProvider } from "./fileTransfer";
import {
  type CompareSide,
  copyable,
  copyRows,
  listSide,
  loadComparison,
  newerOnTarget,
  TOO_MANY,
  withTargetTimes,
} from "./folderCompare";

const provider = (over: Partial<FileProvider> = {}) =>
  ({
    type: "remote",
    id: "p",
    listFilesRecursive: vi.fn(async () => []),
    mkdirAll: vi.fn(async () => {}),
    ...over,
  }) as unknown as FileProvider;

const entry = (path: string, size = 1, mtime = 100) => ({
  path,
  isDir: false,
  size,
  mtime,
});

const row = (
  path: string,
  status: CompareRow["status"],
  isDir = false,
): CompareRow => ({
  path,
  status,
  isDir,
  left: entry(path),
  right: entry(path, 2),
});

describe("folderCompare", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.transferFiles.mockClear();
  });

  it("lists local folders through the Rust command with the cap", async () => {
    mocks.invoke.mockResolvedValue([entry("a.txt")]);
    const side: CompareSide = {
      kind: "local",
      provider: provider({ type: "local" } as Partial<FileProvider>),
      root: "/home/me/site",
    };
    expect(await listSide(side)).toEqual([entry("a.txt")]);
    expect(mocks.invoke).toHaveBeenCalledWith("local_list_recursive", {
      path: "/home/me/site",
      cap: 20000,
    });
  });

  it("refuses remote listings over the cap", async () => {
    const items = Array.from({ length: 20001 }, (_, i) => ({
      name: `${i}`,
      path: `/r/${i}`,
      type: "file",
      size: 1,
      modifiedAt: new Date(0).toISOString(),
    }));
    const side: CompareSide = {
      kind: "remote",
      provider: provider({
        listFilesRecursive: vi.fn(async () => items),
      } as unknown as Partial<FileProvider>),
      root: "/r",
    };
    await expect(listSide(side)).rejects.toThrow(TOO_MANY);
  });

  it("listing_error_shows_message_not_rows", async () => {
    const bad: CompareSide = {
      kind: "remote",
      provider: provider({
        listFilesRecursive: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      } as Partial<FileProvider>),
      root: "/r",
    };
    mocks.invoke.mockResolvedValue([]);
    const local: CompareSide = {
      kind: "local",
      provider: provider(),
      root: "/l",
    };
    await expect(loadComparison(local, bad)).rejects.toThrow(
      "Permission denied",
    );
  });

  it("copies only new and changed rows in the chosen direction", () => {
    const rows = [
      row("new.txt", "onlyLeft"),
      row("gone.txt", "onlyRight"),
      row("changed.txt", "differs"),
      row("same.txt", "same"),
      row("clash", "conflict"),
    ];
    expect(copyable(rows, "right").map((r) => r.path)).toEqual([
      "new.txt",
      "changed.txt",
    ]);
    expect(copyable(rows, "left").map((r) => r.path)).toEqual([
      "gone.txt",
      "changed.txt",
    ]);
  });

  it("Sync → copies onlyLeft and differs with replace only for differs", async () => {
    const left: CompareSide = {
      kind: "local",
      provider: provider(),
      root: "/l",
    };
    const right: CompareSide = {
      kind: "remote",
      provider: provider(),
      root: "/r",
    };
    await copyRows(
      [row("a.txt", "onlyLeft"), row("sub/b.txt", "differs"), row("x", "same")],
      "right",
      left,
      right,
    );
    expect(right.provider.mkdirAll).toHaveBeenCalledWith(["/r/sub"]);
    const calls = mocks.transferFiles.mock.calls.map((c) => {
      const o = (c as unknown as [Record<string, unknown>])[0];
      return {
        destPath: o.destPath,
        files: (o.files as { path: string }[]).map((f) => f.path),
        replace: [
          ...(
            (o.overrides as Map<string, { action: string }>) ?? new Map()
          ).entries(),
        ],
        silent: o.silent,
      };
    });
    expect(calls).toEqual([
      { destPath: "/r", files: ["/l/a.txt"], replace: [], silent: true },
      {
        destPath: "/r/sub",
        files: ["/l/sub/b.txt"],
        replace: [["/l/sub/b.txt", { action: "replace" }]],
        silent: true,
      },
    ]);
  });

  it("finds changed files whose target copy is newer", () => {
    const r = (path: string, l: number, rt: number): CompareRow => ({
      path,
      status: "differs",
      isDir: false,
      left: { path, isDir: false, size: 1, mtime: l },
      right: { path, isDir: false, size: 2, mtime: rt },
    });
    const rows = [
      r("older-there", 200, 100),
      r("newer-there", 100, 200),
      r("close", 100, 102),
    ];
    expect(newerOnTarget(rows, "right").map((x) => x.path)).toEqual([
      "newer-there",
    ]);
    expect(newerOnTarget(rows, "left").map((x) => x.path)).toEqual([
      "older-there",
    ]);
  });

  it("creates an empty folder instead of copying it", async () => {
    const left: CompareSide = {
      kind: "local",
      provider: provider(),
      root: "/l",
    };
    const right: CompareSide = {
      kind: "remote",
      provider: provider(),
      root: "/r",
    };
    await copyRows([row("empty", "onlyLeft", true)], "right", left, right);
    expect(right.provider.mkdirAll).toHaveBeenCalledWith(["/r/empty"]);
    expect(mocks.transferFiles).not.toHaveBeenCalled();
  });

  it("reads a bucket target's saved times before the newer-file check", async () => {
    const statTimes = vi.fn(async () => ({ size: 2, mtime: 100 }));
    const target: CompareSide = {
      kind: "storage",
      provider: provider({ statTimes } as never),
      root: "/r",
    };
    // Listed bucket time is the upload time (newer); the saved one matches the source.
    const rows = [
      {
        path: "a.txt",
        status: "differs" as const,
        isDir: false,
        left: entry("a.txt", 1, 100),
        right: entry("a.txt", 2, 5_000),
      },
    ];
    expect(newerOnTarget(rows, "right")).toHaveLength(1);
    const timed = await withTargetTimes(rows, "right", target);
    expect(statTimes).toHaveBeenCalledWith("/r/a.txt");
    expect(newerOnTarget(timed, "right")).toHaveLength(0);
  });

  it("leaves other targets' times alone", async () => {
    const rows = [row("a.txt", "differs")];
    const side: CompareSide = {
      kind: "remote",
      provider: provider(),
      root: "/r",
    };
    expect(await withTargetTimes(rows, "right", side)).toBe(rows);
  });
});
