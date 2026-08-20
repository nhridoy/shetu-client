import { describe, expect, it } from "vitest";
import type { FileItem } from "@/types/sftp/sftpTypes";
import { parentPath, resolveTransferPaths } from "./fileTransfer";

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
