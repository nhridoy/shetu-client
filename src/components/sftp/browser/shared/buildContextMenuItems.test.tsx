import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import type { FileItem } from "@/types/sftp/sftpTypes";
import { buildContextMenuItems } from "./buildContextMenuItems";

const file: FileItem = {
  name: "a.ts",
  path: "/work/a.ts",
  type: "file",
  size: 10,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
};

const dir: FileItem = {
  name: "src",
  path: "/work/src",
  type: "directory",
  size: 0,
  permissions: "",
  owner: "",
  group: "",
  modifiedAt: "",
  isHidden: false,
};

const isItem = (
  i: ContextMenuItem,
): i is Extract<ContextMenuItem, { label: string }> => "label" in i;

const findItem = (items: ContextMenuItem[], label: string) =>
  items.find(
    (i): i is Extract<ContextMenuItem, { label: string }> =>
      isItem(i) && i.label === label,
  );

const baseActions = {
  handleDoubleClick: vi.fn(),
  handleDownload: vi.fn(),
  onCopy: vi.fn(),
  onCut: vi.fn(),
  onPaste: vi.fn(),
  onDelete: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
};

describe("buildContextMenuItems", () => {
  it("adds Open in Editor before base items for a file", () => {
    const onOpenInEditor = vi.fn();
    const items = buildContextMenuItems(
      file,
      null,
      { ...baseActions, onOpenInEditor },
      vi.fn(),
    );
    expect(findItem(items, "Open in Editor")).toBeDefined();
    expect(items.filter(isItem)[0].label).toBe("Open in Editor");
  });

  it("adds Open in Editor for a directory", () => {
    const items = buildContextMenuItems(
      dir,
      null,
      { ...baseActions, onOpenInEditor: vi.fn() },
      vi.fn(),
    );
    expect(findItem(items, "Open in Editor")).toBeDefined();
  });

  it("adds Open in Editor to the tail for the empty area", () => {
    const onOpenInEditor = vi.fn();
    const items = buildContextMenuItems(
      null,
      null,
      { ...baseActions, onOpenInEditor },
      vi.fn(),
    );
    expect(findItem(items, "Open in Editor")).toBeDefined();
    expect(items[items.length - 1]).toMatchObject({ label: "Open in Editor" });
  });

  it("omits Open in Editor when the handler is absent", () => {
    const items = buildContextMenuItems(file, null, baseActions, vi.fn());
    expect(findItem(items, "Open in Editor")).toBeUndefined();
  });

  it("passes the clicked file to the handler", () => {
    const onOpenInEditor = vi.fn();
    const items = buildContextMenuItems(
      file,
      null,
      { ...baseActions, onOpenInEditor },
      vi.fn(),
    );
    const item = findItem(items, "Open in Editor");
    item?.onClick?.();
    expect(onOpenInEditor).toHaveBeenCalledWith(file);
  });

  it("passes null to the handler for the empty area", () => {
    const onOpenInEditor = vi.fn();
    const items = buildContextMenuItems(
      null,
      null,
      { ...baseActions, onOpenInEditor },
      vi.fn(),
    );
    const item = findItem(items, "Open in Editor");
    item?.onClick?.();
    expect(onOpenInEditor).toHaveBeenCalledWith(null);
  });
});
