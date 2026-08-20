import { describe, expect, it, vi } from "vitest";
import type { FileItem } from "@/types/sftp/sftpTypes";
import {
  parseGlobList,
  relativeWorkspacePath,
  type SearchOptions,
  searchWorkspace,
} from "./workspaceSearch";

const item = (name: string, path: string): FileItem => ({
  name,
  path,
  type: "file",
  size: 100,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
});

const defaultOptions: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

describe("parseGlobList", () => {
  it("splits on newlines and commas and strips negation markers", () => {
    const re = parseGlobList("*.ts\n!test/*.ts, *.md");
    expect(re).toHaveLength(3);
    expect(re[0].test("a.ts")).toBe(true);
    expect(re[1].test("test/a.ts")).toBe(true);
    expect(re[2].test("docs/readme.md")).toBe(true);
    expect(re[2].test("docs/x.ts")).toBe(false);
  });
});

describe("relativeWorkspacePath", () => {
  it("returns the path relative to the root", () => {
    expect(relativeWorkspacePath("/root", "/root/src/a.ts")).toBe("src/a.ts");
    expect(relativeWorkspacePath("C:\\root", "C:\\root\\a.ts")).toBe("a.ts");
  });
});

describe("searchWorkspace", () => {
  it("searches through an injected reader and listDir", async () => {
    const tree: Record<string, FileItem[]> = {
      "/root": [item("a.ts", "/root/a.ts"), item("b.ts", "/root/b.ts")],
    };
    const bytes = (text: string) => new TextEncoder().encode(text);
    const reader = vi.fn(async (path: string) => {
      if (path.endsWith("a.ts")) return bytes("const x = 1;\n");
      if (path.endsWith("b.ts")) return bytes("const y = 2;\n");
      return bytes("");
    });
    const results = await searchWorkspace(
      "/root",
      "x",
      defaultOptions,
      "",
      "",
      undefined,
      reader,
      async (path) => tree[path] ?? [],
    );
    expect(results).toHaveLength(1);
    expect(results[0].file.path).toBe("/root/a.ts");
    expect(results[0].matches).toEqual([
      expect.objectContaining({ line: 1, column: 6, length: 1 }),
    ]);
    expect(reader).toHaveBeenCalledWith("/root/a.ts");
    expect(reader).toHaveBeenCalledWith("/root/b.ts");
  });

  it("skips binary files", async () => {
    const tree: Record<string, FileItem[]> = {
      "/root": [item("bin", "/root/bin")],
    };
    const reader = vi.fn(async () => new Uint8Array([0, 1, 2, 3]));
    const results = await searchWorkspace(
      "/root",
      "anything",
      defaultOptions,
      "",
      "",
      undefined,
      reader,
      async (path) => tree[path] ?? [],
    );
    expect(results).toEqual([]);
  });

  it("returns nothing for an empty query", async () => {
    const results = await searchWorkspace(
      "/root",
      "  ",
      defaultOptions,
      "",
      "",
    );
    expect(results).toEqual([]);
  });
});
