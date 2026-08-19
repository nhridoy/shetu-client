import { describe, expect, it } from "vitest";
import type { FileItem } from "@/types/sftp/sftpTypes";
import { resolveTransferPaths } from "./fileTransfer";

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
  it("auto-renames a conflicting folder and remaps all children", () => {
    const docs = mkdir("docs", "/src/docs");
    const items = [
      { file: docs, relativePath: "docs" },
      { file: mkfile("a.txt", "/src/docs/a.txt"), relativePath: "docs/a.txt" },
      { file: mkfile("b.txt", "/src/docs/b.txt"), relativePath: "docs/b.txt" },
    ];
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
      "docs (copy)",
      "docs (copy)/a.txt",
      "docs (copy)/b.txt",
    ]);
    expect(
      resolved.find((r) => r.file.path === "/src/docs/a.txt")?.destFilePath,
    ).toBe("/dest/docs (copy)/a.txt");
  });

  it("renames a folder to the user-provided name and remaps children", () => {
    const items = [
      { file: mkdir("docs", "/src/docs"), relativePath: "docs" },
      { file: mkfile("a.txt", "/src/docs/a.txt"), relativePath: "docs/a.txt" },
    ];
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
      "docs-v2",
      "docs-v2/a.txt",
    ]);
  });

  it("skips a conflicting folder and all of its children", () => {
    const items = [
      { file: mkdir("docs", "/src/docs"), relativePath: "docs" },
      { file: mkfile("a.txt", "/src/docs/a.txt"), relativePath: "docs/a.txt" },
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
    expect(resolved[2].skip).toBe(false);
    expect(resolved[2].destFilePath).toBe("/dest/top.txt");
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
    const items = [
      { file: mkdir("docs", "/src/docs"), relativePath: "docs" },
      { file: mkfile("a.txt", "/src/docs/a.txt"), relativePath: "docs/a.txt" },
    ];

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "move",
      undefined,
      new Set(["docs"]),
    );

    expect(resolved[0].relativePath).toBe("docs");
    expect(resolved[1].destFilePath).toBe("/dest/docs/a.txt");
  });

  it("leaves subdirectory files untouched when no root conflict exists", () => {
    const items = [
      { file: mkdir("docs", "/src/docs"), relativePath: "docs" },
      { file: mkfile("a.txt", "/src/docs/a.txt"), relativePath: "docs/a.txt" },
    ];

    const resolved = resolveTransferPaths(
      items,
      "/dest",
      "copy",
      undefined,
      new Set(["unrelated.txt"]),
    );

    expect(resolved[0].relativePath).toBe("docs");
    expect(resolved[1].destFilePath).toBe("/dest/docs/a.txt");
  });
});
