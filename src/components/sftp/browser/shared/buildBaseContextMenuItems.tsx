import {
  ClipboardTextIcon,
  CopyIcon,
  FilePlusIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  ScissorsIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface BaseContextMenuActions {
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: (file: FileItem) => void;
  onDeleteSelected?: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

export interface BaseContextMenuOptions {
  menuFile: FileItem | null;
  selectedFiles?: Set<string>;
  hasClipboard: boolean;
  actions: BaseContextMenuActions;
  onRename: (file: FileItem) => void;
  beforeItems?: ContextMenuItem[];
  afterItems?: ContextMenuItem[];
}

/**
 * Builds the common context menu items shared between local and remote file browsers.
 * Provider-specific items can be injected via `beforeItems` (after the file header)
 * and `afterItems` (appended at the end).
 */
export function buildBaseContextMenuItems({
  menuFile,
  selectedFiles,
  hasClipboard,
  actions,
  onRename,
  beforeItems,
  afterItems,
}: BaseContextMenuOptions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (menuFile) {
    // Provider-specific file items (Open, Download, Show in Explorer, etc.)
    if (beforeItems) items.push(...beforeItems);

    items.push({ type: "separator" as const });
    items.push({
      label: "Copy",
      icon: <CopyIcon className="w-4 h-4" />,
      shortcut: "Ctrl+C",
      onClick: actions.onCopy,
    });
    items.push({
      label: "Cut",
      icon: <ScissorsIcon className="w-4 h-4" />,
      shortcut: "Ctrl+X",
      onClick: actions.onCut,
    });
  }

  items.push({
    label: "Paste",
    icon: <ClipboardTextIcon className="w-4 h-4" />,
    shortcut: "Ctrl+V",
    disabled: !hasClipboard,
    onClick: actions.onPaste,
  });

  items.push({ type: "separator" as const });
  items.push({
    label: "New Folder",
    icon: <FolderPlusIcon className="w-4 h-4" />,
    shortcut: "Ctrl+Shift+N",
    onClick: actions.onNewFolder,
  });
  items.push({
    label: "New File",
    icon: <FilePlusIcon className="w-4 h-4" />,
    shortcut: "Ctrl+N",
    onClick: actions.onNewFile,
  });

  if (menuFile) {
    items.push({ type: "separator" as const });
    items.push({
      label: "Rename",
      icon: <PencilSimpleIcon className="w-4 h-4" />,
      shortcut: "F2",
      onClick: () => onRename(menuFile),
    });
    items.push({ type: "separator" as const });
    items.push({
      label: "Delete",
      icon: <TrashIcon className="w-4 h-4" />,
      shortcut: "Del",
      danger: true,
      onClick: () => {
        // If right-clicked file is part of a multi-selection, delete all selected
        if (
          selectedFiles &&
          selectedFiles.size > 1 &&
          selectedFiles.has(menuFile.name) &&
          actions.onDeleteSelected
        ) {
          actions.onDeleteSelected();
        } else {
          actions.onDelete(menuFile);
        }
      },
    });
  }

  // Provider-specific items at the end (Copy path, Refresh, etc.)
  if (afterItems) items.push(...afterItems);

  return items;
}
