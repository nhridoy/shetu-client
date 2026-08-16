import { type RefObject, useCallback } from "react";
import { LocalFileProvider, transferFiles } from "@/lib/sftp/fileTransfer";
import { listLocalFiles, writeLocalFileBytes } from "@/lib/sftp/localFs";
import { fileBrowserActions } from "@/stores/sftp/fileBrowserStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface UseDesktopFileDropParams {
  paneId: string;
  currentPath: string;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useDesktopFileDrop({
  paneId,
  currentPath,
  containerRef,
}: UseDesktopFileDropParams) {
  const actions = fileBrowserActions;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget === containerRef.current) {
        // Reset isDragOver — caller manages state
      }
    },
    [containerRef],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const droppedFiles = e.dataTransfer.files;
      if (droppedFiles.length === 0) return;

      const fileItems: FileItem[] = [];
      for (let i = 0; i < droppedFiles.length; i++) {
        const f = droppedFiles[i];
        fileItems.push({
          name: f.name,
          path: f.name,
          type: "file",
          size: f.size,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date(f.lastModified).toISOString(),
          isHidden: f.name.startsWith("."),
        });
      }

      // Write files to temp directory, then use unified transferFiles
      const { tempdir } = await import("@tauri-apps/api/path");
      const tempDir = await tempdir();

      const tempFiles: FileItem[] = [];
      for (let i = 0; i < droppedFiles.length; i++) {
        const f = droppedFiles[i];
        const tempPath = `${tempDir}/sftp-drop-${crypto.randomUUID()}-${f.name}`;
        const arrayBuffer = await f.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        await writeLocalFileBytes(tempPath, bytes);
        tempFiles.push({
          ...fileItems[i],
          path: tempPath,
        });
      }

      const localProvider = new LocalFileProvider("local");

      await transferFiles({
        source: localProvider,
        dest: localProvider,
        files: tempFiles,
        destPath: currentPath,
        mode: "copy",
        sessionId: paneId,
      });

      // Cleanup temp files
      const { removeFile } = await import("@tauri-apps/plugin-fs");
      for (const tf of tempFiles) {
        await removeFile(tf.path).catch(() => {});
      }

      actions.loadFiles(paneId, currentPath, listLocalFiles);
    },
    [currentPath, paneId],
  );

  return { handleDragOver, handleDragLeave, handleDrop };
}
