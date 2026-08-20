import { describe, expect, it, vi } from "vitest";
import type { FileProvider } from "@/lib/sftp/fileTransfer";
import type { FileItem } from "@/types/sftp/sftpTypes";
import {
  collectProviderWorkspaceFiles,
  collectWorkspaceFiles,
  WORKSPACE_FILE_LIMIT,
} from "./workspaceFiles";

const item = (
  name: string,
  path: string,
  type: "file" | "directory",
): FileItem => ({
  name,
  path,
  type,
  size: 1,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
});

const tree = {
  "/root": [
    item("a.ts", "/root/a.ts", "file"),
    item("src", "/root/src", "directory"),
    item("node_modules", "/root/node_modules", "directory"),
    item(".git", "/root/.git", "directory"),
  ],
  "/root/src": [item("b.ts", "/root/src/b.ts", "file")],
};

const fakeList = vi.fn(
  async (path: string) => tree[path as keyof typeof tree] ?? [],
);

describe("collectWorkspaceFiles", () => {
  it("walks the tree via the injected listDir and skips ignored dirs", async () => {
    const files = await collectWorkspaceFiles("/root", fakeList);
    expect(files.map((f) => f.path)).toEqual(["/root/a.ts", "/root/src/b.ts"]);
    expect(fakeList).toHaveBeenCalledWith("/root");
    expect(fakeList).toHaveBeenCalledWith("/root/src");
    expect(fakeList).not.toHaveBeenCalledWith("/root/node_modules");
    expect(fakeList).not.toHaveBeenCalledWith("/root/.git");
  });

  it("swallows list errors for unreadable directories", async () => {
    const list = vi.fn(async () => {
      throw new Error("boom");
    });
    const files = await collectWorkspaceFiles("/root", list);
    expect(files).toEqual([]);
  });

  it("caps the file count", async () => {
    const list = vi.fn(async () =>
      Array.from({ length: WORKSPACE_FILE_LIMIT + 50 }, (_, i) =>
        item(`f${i}.ts`, `/root/f${i}.ts`, "file"),
      ),
    );
    const files = await collectWorkspaceFiles("/root", list);
    expect(files.length).toBe(WORKSPACE_FILE_LIMIT);
  });
});

describe("collectProviderWorkspaceFiles", () => {
  it("delegates listing to the provider", async () => {
    const provider = {
      listFiles: vi.fn(
        async (path: string) => tree[path as keyof typeof tree] ?? [],
      ),
    } as unknown as FileProvider;
    const files = await collectProviderWorkspaceFiles(provider, "/root");
    expect(files.map((f) => f.path)).toEqual(["/root/a.ts", "/root/src/b.ts"]);
    expect(provider.listFiles).toHaveBeenCalledWith("/root");
    expect(provider.listFiles).toHaveBeenCalledWith("/root/src");
  });
});
