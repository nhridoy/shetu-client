import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import { matchesBinding } from "@/lib/shortcuts/binding";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import {
  effectiveBinding,
  shortcutLabel,
} from "@/stores/shortcuts/shortcutStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface ExplorerMenuHandlers {
  openFile: (path: string, name: string, isPreview: boolean) => void;
  openInSystem: (path: string) => void;
  setNewFileParent: (path: string) => void;
  setNewFolderParent: (path: string) => void;
  startRename: (file: FileItem) => void;
  setDeletePath: (path: string) => void;
  revealInExplorer: (path: string) => void;
  copyPath: (path: string) => void;
  refreshDir: (path: string) => void;
}

export interface ExplorerMenuParams {
  file: FileItem | null;
  isDir: boolean;
  parent: string;
  rootPath: string;
  isRemote: boolean;
  handlers: ExplorerMenuHandlers;
}

export function buildExplorerMenuItems({
  file,
  isDir,
  parent,
  rootPath,
  isRemote,
  handlers,
}: ExplorerMenuParams): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (file && !isDir) {
    items.push({
      label: "Open",
      onClick: () => handlers.openFile(file.path, file.name, false),
    });
    if (!isRemote) {
      items.push({
        label: "Open with Default App",
        onClick: () => handlers.openInSystem(file.path),
      });
    }
    items.push({ type: "separator" });
  }

  items.push(
    {
      label: "New File",
      onClick: () =>
        handlers.setNewFileParent(isDir && file ? file.path : parent),
    },
    {
      label: "New Folder",
      onClick: () =>
        handlers.setNewFolderParent(isDir && file ? file.path : parent),
    },
  );

  if (file) {
    items.push(
      { type: "separator" },
      {
        label: "Rename",
        shortcut: shortcutLabel("editor.rename"),
        onClick: () => handlers.startRename(file),
      },
      {
        label: "Delete",
        shortcut: shortcutLabel("editor.delete"),
        danger: true,
        onClick: () => handlers.setDeletePath(file.path),
      },
      { type: "separator" },
    );
    if (!isRemote) {
      items.push({
        label: "Reveal in Explorer",
        onClick: () => handlers.revealInExplorer(file.path),
      });
    }
    items.push({
      label: "Copy Path",
      onClick: () => handlers.copyPath(file.path),
    });
  }

  items.push(
    { type: "separator" },
    {
      label: "Refresh",
      onClick: () => handlers.refreshDir(file ? parent : rootPath),
    },
  );

  return items;
}

export type ExplorerKeyAction = "rename" | "delete" | "copyPath" | "open";

/** What a key pressed in the explorer tree does; null for keys typed in the rename box. */
export function explorerKeyAction(e: KeyboardEvent): ExplorerKeyAction | null {
  const target = e.target as HTMLElement | null;
  if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return null;
  const is = (id: ShortcutId) => matchesBinding(e, effectiveBinding(id));
  if (is("editor.rename")) return "rename";
  if (is("editor.delete")) return "delete";
  // Before Enter, so a binding like Ctrl+Enter isn't swallowed by "open".
  if (is("editor.copyPath")) return "copyPath";
  if (e.key === "Enter") return "open";
  return null;
}
