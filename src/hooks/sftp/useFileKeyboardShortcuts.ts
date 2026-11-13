import { useEffect } from "react";
import { useShortcut } from "@/hooks/useShortcut";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface UseFileKeyboardShortcutsOptions {
  selectedFiles: Set<string>;
  files: FileItem[];

  // Core actions (required)
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onRename: (file: FileItem) => void;
  onRefresh: () => void;
  onNavigateUp: () => void;
  onClearSelection: () => void;

  // New file/folder (optional — wire up for local)
  onNewFile?: () => void;
  onNewFolder?: () => void;

  // Select all (optional — wire up for remote)
  onSelectAll?: () => void;

  // Active pane gating (optional — wire up for remote multi-pane)
  activePaneId?: string | null;
  paneId?: string;

  // Modal dialog handling (optional — wire up for remote)
  deleteConfirm?: {
    files: FileItem[];
    selectedNames: Set<string> | null;
  } | null;
  pasteConflicts?:
    | { srcPath: string; dstPath: string; dstName: string }[]
    | null;
  onConfirmDelete?: () => void;
  onDismissDeleteConfirm?: () => void;
  onDismissPasteConflicts?: () => void;
}

export function useFileKeyboardShortcuts({
  selectedFiles,
  files,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onRename,
  onRefresh,
  onNavigateUp,
  onClearSelection,
  onNewFile,
  onNewFolder,
  onSelectAll,
  activePaneId,
  paneId,
  deleteConfirm,
  pasteConflicts,
  onConfirmDelete,
  onDismissDeleteConfirm,
  onDismissPasteConflicts,
}: UseFileKeyboardShortcutsOptions) {
  // Shortcuts pause in another pane and while a dialog owns the keyboard.
  const enabled =
    !(activePaneId && paneId && activePaneId !== paneId) &&
    !deleteConfirm &&
    !pasteConflicts;
  const when = (cb?: () => void) =>
    [() => cb?.(), { enabled: enabled && !!cb }] as const;
  useShortcut("files.copy", ...when(onCopy));
  useShortcut("files.cut", ...when(onCut));
  useShortcut("files.paste", ...when(onPaste));
  useShortcut("files.newFile", ...when(onNewFile));
  useShortcut("files.newFolder", ...when(onNewFolder));
  useShortcut("files.selectAll", ...when(onSelectAll));
  useShortcut("files.refresh", ...when(onRefresh));
  useShortcut("files.up", ...when(onNavigateUp));
  useShortcut(
    "files.rename",
    ...when(() => {
      if (selectedFiles.size !== 1) return;
      const name = [...selectedFiles][0];
      const file = files.find((f) => f.name === name);
      if (file) onRename(file);
    }),
  );
  useShortcut(
    "files.delete",
    ...when(() => {
      if (selectedFiles.size > 0) onDelete();
    }),
  );

  // Dialog keys and Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Active pane gating (remote multi-pane)
      if (activePaneId && paneId && activePaneId !== paneId) return;

      // Modal dialog handling — intercept all keys when a dialog is open
      if (deleteConfirm) {
        if (e.key === "Enter") {
          e.preventDefault();
          onConfirmDelete?.();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onDismissDeleteConfirm?.();
          return;
        }
        return;
      }
      if (pasteConflicts) {
        if (e.key === "Enter") {
          e.preventDefault();
          // Click the confirm button in the paste conflict dialog
          const container = document.querySelector(
            "[data-paste-dialog]",
          ) as HTMLElement | null;
          const btn = container?.querySelector(
            "button:last-child",
          ) as HTMLButtonElement | null;
          btn?.click();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onDismissPasteConflicts?.();
          return;
        }
        return;
      }

      // Escape clears the selection (not a rebindable shortcut).
      if (e.key === "Escape") {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA")
          onClearSelection();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    onClearSelection,
    activePaneId,
    paneId,
    deleteConfirm,
    pasteConflicts,
    onConfirmDelete,
    onDismissDeleteConfirm,
    onDismissPasteConflicts,
  ]);
}
