import { describe, expect, it } from "vitest";
import type { FileItem } from "@/types/sftp/sftpTypes";
import {
  type CompareEntry,
  compareFolders,
  toCompareEntries,
} from "./compareFolders";

const f = (path: string, size = 1, mtime = 100): CompareEntry => ({
  path,
  isDir: false,
  size,
  mtime,
});
const d = (path: string): CompareEntry => ({
  path,
  isDir: true,
  size: 0,
  mtime: 0,
});
const statusOf = (rows: ReturnType<typeof compareFolders>) =>
  Object.fromEntries(rows.map((r) => [r.path, r.status]));

describe("compareFolders", () => {
  it("marks only-left, only-right, same and differs", () => {
    const rows = compareFolders(
      [f("a.txt"), f("same.txt"), f("changed.txt", 1)],
      [f("b.txt"), f("same.txt"), f("changed.txt", 2)],
    );
    expect(statusOf(rows)).toEqual({
      "a.txt": "onlyLeft",
      "b.txt": "onlyRight",
      "changed.txt": "differs",
      "same.txt": "same",
    });
    expect(rows.map((r) => r.path)).toEqual([
      "a.txt",
      "b.txt",
      "changed.txt",
      "same.txt",
    ]);
  });

  it("treats a 2 s time difference as same and 3 s as differs", () => {
    expect(compareFolders([f("x", 1, 100)], [f("x", 1, 102)])[0].status).toBe(
      "same",
    );
    expect(compareFolders([f("x", 1, 100)], [f("x", 1, 103)])[0].status).toBe(
      "differs",
    );
  });

  it("treats a size difference as differs even with equal times", () => {
    expect(compareFolders([f("x", 1)], [f("x", 9)])[0].status).toBe("differs");
  });

  it("flags a file on one side and a folder on the other as conflict", () => {
    const rows = compareFolders([f("x")], [d("x")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("conflict");
  });

  it("lists an empty folder that exists only on one side", () => {
    const rows = compareFolders([d("empty")], []);
    expect(rows).toEqual([
      expect.objectContaining({
        path: "empty",
        status: "onlyLeft",
        isDir: true,
      }),
    ]);
  });

  it("does not list a folder whose files are listed", () => {
    const rows = compareFolders([d("sub"), f("sub/a.txt")], []);
    expect(rows.map((r) => r.path)).toEqual(["sub/a.txt"]);
    expect(compareFolders([d("both")], [d("both")])).toEqual([]);
  });

  it("normalises backslash paths from local listings", () => {
    const item = (path: string, type: FileItem["type"]): FileItem => ({
      name: path.split("\\").pop() ?? path,
      path,
      type,
      size: 5,
      permissions: "",
      owner: "",
      group: "",
      modifiedAt: new Date(1_700_000_000_500).toISOString(),
      isHidden: false,
    });
    expect(
      toCompareEntries("C:\\site", [
        item("C:\\site\\a", "directory"),
        item("C:\\site\\a\\b.txt", "file"),
      ]),
    ).toEqual([
      { path: "a", isDir: true, size: 5, mtime: 1_700_000_000 },
      { path: "a/b.txt", isDir: false, size: 5, mtime: 1_700_000_000 },
    ]);
  });
});
