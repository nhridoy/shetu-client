import { useCallback } from "react";
import { toast } from "sonner";
import { extractError } from "@/lib/common/extractError";
import { buildClipboardPaths } from "@/lib/sftp/buildClipboardPaths";
import {
  type FileProvider,
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
      // Build source files from clipboard
      const sourceFiles: FileItem[] = clipboard.paths.map((srcPath) => {
        const name = srcPath.split(/[/\\]/).pop() || srcPath;
        return {
          name,
          path: srcPath,
          type: "file" as const,
          size: 0,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date().toISOString(),
          isHidden: name.startsWith("."),
        };
      });

      // Determine source provider
      const isLocalSource = clipboard.hostId === "local";
      let sourceProvider: FileProvider;
      if (isLocalSource) {
        sourceProvider = new LocalFileProvider("local");
      } else {
        // Remote source - get from registry
        const sourceFromRegistry = getProvider(clipboard.hostId);
        if (!sourceFromRegistry) {
          toast.error("Source session not found. Please reconnect.");
          return;
        }
        sourceProvider = sourceFromRegistry;
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
