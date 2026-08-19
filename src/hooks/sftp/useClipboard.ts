import { useCallback } from "react";
import { toast } from "sonner";
import { extractError } from "@/lib/common/extractError";
import { buildClipboardPaths } from "@/lib/sftp/buildClipboardPaths";
import {
  type FileProvider,
  joinPath,
  LocalFileProvider,
  transferFiles,
} from "@/lib/sftp/fileTransfer";
import { listLocalFiles } from "@/lib/sftp/localFs";
import { getProvider } from "@/lib/sftp/providerRegistry";
import {
  fileBrowserActions,
  useFileBrowserStore,
} from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface UseClipboardParams {
  paneId: string;
  currentPath: string;
  files: FileItem[];
  selectedFiles: Set<string>;
}

export function useClipboard({
  paneId,
  currentPath,
  files,
  selectedFiles,
}: UseClipboardParams) {
  const actions = fileBrowserActions;

  const handleCopy = useCallback(() => {
    const paths = buildClipboardPaths(selectedFiles, files);
    if (paths.length === 0) return;
    useSftpStore.getState().setClipboard("local", paths, "copy");
    toast.success(`Copied ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [selectedFiles, files]);

  const handleCut = useCallback(() => {
    const paths = buildClipboardPaths(selectedFiles, files);
    if (paths.length === 0) return;
    useSftpStore.getState().setClipboard("local", paths, "cut");
    toast.success(`Cut ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [selectedFiles, files]);

  const handlePaste = useCallback(async () => {
    const { clipboard, clipboardMode } = useSftpStore.getState();
    if (!clipboard || !clipboardMode) return;

    try {
      // Determine source provider
      const isLocalSource = clipboard.sourceId === "local";
      let sourceProvider: FileProvider;
      if (isLocalSource) {
        sourceProvider = new LocalFileProvider("local");
      } else {
        // Remote source - get from registry
        const sourceFromRegistry = getProvider(clipboard.sourceId);
        if (!sourceFromRegistry) {
          toast.error("Source session not found. Please reconnect.");
          return;
        }
        sourceProvider = sourceFromRegistry;
      }

      // Build source files from clipboard, detecting if they're directories
      const sourceFiles: FileItem[] = [];
      for (const srcPath of clipboard.paths) {
        const name = srcPath.split(/[/\\]/).pop() || srcPath;
        const isDir = await sourceProvider
          .isDirectory(srcPath)
          .catch(() => false);
        sourceFiles.push({
          name,
          path: srcPath,
          type: isDir ? "directory" : "file",
          size: 0,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date().toISOString(),
          isHidden: name.startsWith("."),
        });
      }

      // Detect destination name conflicts and surface the dialog
      let destFiles: FileItem[];
      try {
        destFiles = await listLocalFiles(currentPath);
      } catch {
        destFiles = [];
      }
      const destNames = new Set(destFiles.map((f) => f.name));
      const conflicts = sourceFiles.filter((f) => destNames.has(f.name));

      if (conflicts.length > 0) {
        actions.setPasteConflicts(
          paneId,
          conflicts.map((f) => ({
            srcPath: f.path,
            dstPath: joinPath(currentPath, f.name),
            dstName: f.name,
          })),
        );
        actions.setPendingDrop(paneId, {
          files: sourceFiles,
          destDirPath: currentPath,
          mode: clipboardMode === "cut" ? "move" : "copy",
          sourceHostId: clipboard.sourceId,
          sourcePaneId:
            clipboard.sourceId === "local" ? undefined : clipboard.sourceId,
          sourceKind: "clipboard",
        });
        return;
      }

      const localProvider = new LocalFileProvider("local");

      await transferFiles({
        source: sourceProvider,
        dest: localProvider,
        files: sourceFiles,
        destPath: currentPath,
        mode: clipboardMode === "cut" ? "move" : "copy",
        sessionId: paneId,
      });

      try {
        const freshFiles = await listLocalFiles(currentPath);
        actions.setFiles(paneId, freshFiles);
      } catch {
        // silent fail
      }

      // Refresh source panes if cut
      if (clipboardMode === "cut") {
        const allPanes = useFileBrowserStore.getState().panes;
        for (const [id, p] of Object.entries(allPanes)) {
          if (id === paneId) continue;
          for (const srcPath of clipboard.paths) {
            const srcDir = srcPath
              .replace(/[/\\][^/\\]+$/, "")
              .replace(/\\/g, "/");
            const paneDir = p.currentPath.replace(/\\/g, "/");
            if (paneDir === srcDir) {
              try {
                const srcFresh = await listLocalFiles(p.currentPath);
                fileBrowserActions.setFiles(id, srcFresh);
              } catch {
                // silent fail
              }
            }
          }
        }
      }

      useSftpStore.getState().clearClipboard();
    } catch (err: unknown) {
      toast.error(`Paste failed: ${extractError(err)}`);
    }
  }, [currentPath, paneId]);

  return { handleCopy, handleCut, handlePaste };
}
