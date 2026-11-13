import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import type { FileItem } from "@/types/sftp/sftpTypes";
import { buildExplorerMenuItems, explorerKeyAction } from "./explorerMenu";

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

const handlers = {
  openFile: vi.fn(),
  openInSystem: vi.fn(),
  setNewFileParent: vi.fn(),
  setNewFolderParent: vi.fn(),
  startRename: vi.fn(),
  setDeletePath: vi.fn(),
  revealInExplorer: vi.fn(),
  copyPath: vi.fn(),
  refreshDir: vi.fn(),
};

const isItem = (
  i: ContextMenuItem,
): i is Extract<ContextMenuItem, { label: string }> => "label" in i;

const labels = (items: ContextMenuItem[]) =>
  items.filter(isItem).map((i) => i.label);

const findItem = (items: ContextMenuItem[], label: string) =>
  items.find(
    (i): i is Extract<ContextMenuItem, { label: string }> =>
      isItem(i) && i.label === label,
  );

describe("buildExplorerMenuItems", () => {
  it("file menu opens the file and includes local-only items when local", () => {
    const items = buildExplorerMenuItems({
      file,
      isDir: false,
      parent: "/work",
      rootPath: "/work",
      isRemote: false,
      handlers,
    });
    expect(labels(items)).toEqual(
      expect.arrayContaining([
        "Open",
        "Open with Default App",
        "New File",
        "New Folder",
        "Rename",
        "Delete",
        "Reveal in Explorer",
        "Copy Path",
        "Refresh",
      ]),
    );
  });

  it("hides local-only items for remote connections", () => {
    const items = buildExplorerMenuItems({
      file,
      isDir: false,
      parent: "/work",
      rootPath: "/work",
      isRemote: true,
      handlers,
    });
    const ls = labels(items);
    expect(ls).toContain("Open");
    expect(ls).toContain("Copy Path");
    expect(ls).not.toContain("Open with Default App");
    expect(ls).not.toContain("Reveal in Explorer");
  });

  it("directory menu targets the directory as new-file parent", () => {
    const items = buildExplorerMenuItems({
      file: dir,
      isDir: true,
      parent: "/work",
      rootPath: "/work",
      isRemote: false,
      handlers,
    });
    const newFile = findItem(items, "New File");
    newFile?.onClick?.();
    expect(handlers.setNewFileParent).toHaveBeenCalledWith("/work/src");
    expect(labels(items)).not.toContain("Open");
  });

  it("empty-area menu uses rootPath for new items and refresh", () => {
    const items = buildExplorerMenuItems({
      file: null,
      isDir: false,
      parent: "/work",
      rootPath: "/work",
      isRemote: false,
      handlers,
    });
    const refresh = findItem(items, "Refresh");
    refresh?.onClick?.();
    expect(handlers.refreshDir).toHaveBeenCalledWith("/work");
  });

  it("delete action triggers the delete handler", () => {
    const items = buildExplorerMenuItems({
      file,
      isDir: false,
      parent: "/work",
      rootPath: "/work",
      isRemote: false,
      handlers,
    });
    const del = findItem(items, "Delete");
    del?.onClick?.();
    expect(handlers.setDeletePath).toHaveBeenCalledWith("/work/a.ts");
  });

  it("explorer_labels_follow_bindings", async () => {
    const menu = () =>
      buildExplorerMenuItems({
        file,
        isDir: false,
        parent: "/work",
        rootPath: "/work",
        isRemote: false,
        handlers,
      });
    expect(findItem(menu(), "Rename")?.shortcut).toBe("F2");
    await useShortcutStore.getState().setBinding("editor.rename", "ctrl+alt+r");
    expect(findItem(menu(), "Rename")?.shortcut).toBe("Ctrl+Alt+R");
    await useShortcutStore.getState().setBinding("editor.delete", "");
    expect(findItem(menu(), "Delete")?.shortcut).toBeUndefined();
    useShortcutStore.setState({ overrides: {} });
  });

  const keyOn = (tagName: string, init: Partial<KeyboardEvent>) =>
    ({
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...init,
      target: { tagName },
    }) as unknown as KeyboardEvent;

  it("keys_typed_in_the_rename_box_are_ignored", () => {
    expect(
      explorerKeyAction(keyOn("INPUT", { key: "Delete", code: "Delete" })),
    ).toBeNull();
    expect(
      explorerKeyAction(keyOn("INPUT", { key: "Enter", code: "Enter" })),
    ).toBeNull();
    expect(
      explorerKeyAction(keyOn("DIV", { key: "Delete", code: "Delete" })),
    ).toBe("delete");
    expect(explorerKeyAction(keyOn("DIV", { key: "F2", code: "F2" }))).toBe(
      "rename",
    );
  });

  it("copy_path_on_ctrl_enter_beats_open", async () => {
    await useShortcutStore
      .getState()
      .setBinding("editor.copyPath", "ctrl+enter");
    expect(
      explorerKeyAction(
        keyOn("DIV", { key: "Enter", code: "Enter", ctrlKey: true }),
      ),
    ).toBe("copyPath");
    expect(
      explorerKeyAction(keyOn("DIV", { key: "Enter", code: "Enter" })),
    ).toBe("open");
    useShortcutStore.setState({ overrides: {} });
  });
});
