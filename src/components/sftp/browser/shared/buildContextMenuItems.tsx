import {
  ArrowDownIcon,
  CopyIcon,
  FolderOpenIcon,
  LockIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  type BaseContextMenuActions,
  buildBaseContextMenuItems,
} from "@/components/sftp/browser/shared/buildBaseContextMenuItems";
import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface FileBrowserActions extends BaseContextMenuActions {
  handleDoubleClick: (file: FileItem) => void;
  handleDownload: (file: FileItem) => void;
  onPermissions?: (file: FileItem) => void;
}

export function buildContextMenuItems(
  menuFile: FileItem | null,
  clipboard: { paths: string[] } | null,
  actions: FileBrowserActions,
  onRenameStart: (path: string, name: string) => void,
): ContextMenuItem[] {
  const beforeItems: ContextMenuItem[] = [];
  const afterItems: ContextMenuItem[] = [];

  if (menuFile) {
    if (menuFile.type === "directory") {
      beforeItems.push({
        label: "Open",
        icon: <FolderOpenIcon className="w-4 h-4" />,
        shortcut: "Enter",
        onClick: () => actions.handleDoubleClick(menuFile),
      });
    }
    if (menuFile.type === "file") {
      beforeItems.push({
        label: "Download",
        icon: <ArrowDownIcon className="w-4 h-4" />,
        shortcut: "Enter",
        onClick: () => actions.handleDownload(menuFile),
      });
    }

    afterItems.push({
      label: "Copy path",
      icon: <CopyIcon className="w-4 h-4" />,
      onClick: () => {
        if (menuFile.path) navigator.clipboard.writeText(menuFile.path);
        toast.info("Path copied");
      },
    });

    if (actions.onPermissions) {
      afterItems.push({
        label: "Permissions",
        icon: <LockIcon className="w-4 h-4" />,
        onClick: () => actions.onPermissions?.(menuFile),
      });
    }
  }

  return buildBaseContextMenuItems({
    menuFile,
    hasClipboard: !!clipboard && clipboard.paths.length > 0,
    actions: {
      onCopy: actions.onCopy,
      onCut: actions.onCut,
      onPaste: actions.onPaste,
      onDelete: actions.onDelete,
      onNewFile: actions.onNewFile,
      onNewFolder: actions.onNewFolder,
    },
    onRename: (file) => onRenameStart(file.path, file.name),
    beforeItems,
    afterItems,
  });
}
