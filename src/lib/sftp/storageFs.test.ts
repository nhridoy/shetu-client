import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { confirmFolderRename, StorageFileProvider } from "./storageFs";

const entry = (name: string, isDir: boolean, size = 0) => ({
  name,
  path: `/docs/${name}`,
  isDir,
  size,
  mtime: 1_700_000_000,
});

beforeEach(() => h.invoke.mockReset());

describe("StorageFileProvider", () => {
  const p = new StorageFileProvider("storage:a1", "pane-7");

  it("is a remote provider whose session is its pane", () => {
    expect(p.type).toBe("remote");
    expect(p.getSessionId()).toBe("pane-7");
  });

  it("lists objects as files and prefixes as folders", async () => {
    h.invoke.mockResolvedValue([entry("a", true), entry("b.txt", false, 5)]);
    const items = await p.listFiles("/docs");
    expect(h.invoke).toHaveBeenCalledWith("storage_list", {
      sessionId: "pane-7",
      path: "/docs",
    });
    expect(items.map((i) => [i.name, i.type, i.size])).toEqual([
      ["a", "directory", 0],
      ["b.txt", "file", 5],
    ]);
    expect(items[1].modifiedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(items[1].permissions).toBe("");
  });

  it("renames and deletes folders as folders", async () => {
    // No object at the path: it is a folder (a prefix).
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "storage_stat" ? null : undefined,
    );
    await p.moveFile("/docs/a", "/docs/b");
    expect(h.invoke).toHaveBeenCalledWith("storage_rename", {
      sessionId: "pane-7",
      from: "/docs/a",
      to: "/docs/b",
      isDir: true,
    });
    await p.removeFile("/docs/a");
    expect(h.invoke).toHaveBeenCalledWith("storage_delete", {
      sessionId: "pane-7",
      path: "/docs/a",
      isDir: true,
    });
  });

  it("deletes a file as a file", async () => {
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "storage_stat" ? [5, 1_700_000_000] : undefined,
    );
    await p.delete("/docs/b.txt");
    expect(h.invoke).toHaveBeenCalledWith("storage_delete", {
      sessionId: "pane-7",
      path: "/docs/b.txt",
      isDir: false,
    });
    expect(await p.statTimes("/docs/b.txt")).toEqual({
      size: 5,
      mtime: 1_700_000_000,
    });
  });

  it("refuses what buckets can't do", async () => {
    await expect(p.chmod("/x", 0o644)).rejects.toThrow(/bucket/);
    await expect(p.copyFile("/a", "/b")).rejects.toThrow(/another pane/);
  });

  it("asks before renaming a folder, with how many objects move", async () => {
    h.invoke.mockResolvedValue([
      entry("a", false),
      entry("b", false),
      entry("c", true),
    ]);
    const ask = vi.fn(() => false);
    expect(await confirmFolderRename(p, "/docs", "docs", ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("3 items"));
    ask.mockReturnValue(true);
    expect(await confirmFolderRename(p, "/docs", "docs", ask)).toBe(true);
  });
});
