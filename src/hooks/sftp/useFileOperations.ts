import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useModal } from "@/hooks/useModal";
import { extractError } from "@/lib/common/extractError";
import { nameFormSchema } from "@/lib/schema/common/nameFormSchema";
import { RemoteFileProviderImpl } from "@/lib/sftp/remoteFs";
import {
  fileBrowserActions,
  useFileBrowserStore,
} from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface UseFileOperationsParams {
  paneId: string;
  hostId: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  onFileSelect?: (file: FileItem) => void;
}

export function useFileOperations({
  paneId,
  hostId,
  hostAddress,
  hostPort,
  hostUsername,
}: UseFileOperationsParams) {
  const actions = fileBrowserActions;
  const renameInputRef = useRef<HTMLInputElement>(null);

  const pane = useFileBrowserStore((s) => s.panes[paneId]);
  const currentPath = pane?.currentPath ?? "/";
  const files = pane?.files ?? [];
  const selectedFiles = pane?.selectedFiles ?? new Set<string>();
  const renamingPath = pane?.renamingPath ?? null;
  const renameValue = pane?.renameValue ?? "";
  const [deleteConfirm, setDeleteConfirm] = useState<{
    files: FileItem[];
    selectedNames: Set<string> | null;
  } | null>(null);

  const newFileModal = useModal();
  const newFolderModal = useModal();

  // ── SFTP Provider ──────────────────────────────────────────────────────
  const providerRef = useRef<RemoteFileProviderImpl | null>(null);
  const connectingRef = useRef<Promise<RemoteFileProviderImpl> | null>(null);

  const ensureProvider =
    useCallback(async (): Promise<RemoteFileProviderImpl> => {
      if (providerRef.current) return providerRef.current;

      if (connectingRef.current) return connectingRef.current;

      connectingRef.current = (async () => {
        try {
          if (hostId.startsWith("direct_")) {
            await invoke("sftp_connect", {
              sessionId: paneId,
              config: {
                host: hostAddress || "",
                port: hostPort || 22,
                username: hostUsername || "",
              },
            });
          } else {
            await invoke("sftp_connect_saved", {
              sessionId: paneId,
              hostId,
            });
          }

          const provider = new RemoteFileProviderImpl(hostId, paneId);
          providerRef.current = provider;
          return provider;
        } finally {
          connectingRef.current = null;
        }
      })();

      return connectingRef.current;
    }, [paneId, hostId, hostAddress, hostPort, hostUsername]);

  useEffect(() => {
    return () => {
      invoke("sftp_disconnect", { sessionId: paneId }).catch(() => {});
    };
  }, [paneId]);

  const refreshFiles = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      const fresh = await provider.listFiles(currentPath);
      actions.setFiles(paneId, fresh);
    } catch {
      // silent fail
    }
  }, [currentPath, paneId]);

  // ── Rename ───────────────────────────────────────────────────────────────
  const startRename = useCallback(
    (file: FileItem) => actions.startRename(paneId, file.path, file.name),
    [paneId],
  );

  const renamingInProgress = useRef(false);

  const commitRename = useCallback(async () => {
    if (!renamingPath || renamingInProgress.current) return;
    const file = files.find((f) => f.path === renamingPath);
    if (!file || renameValue === file.name || !renameValue.trim()) {
      actions.cancelRename(paneId);
      return;
    }
    const trimmed = renameValue.trim();
    const result = nameFormSchema.safeParse({ name: trimmed });
    if (!result.success) {
      toast.error(result.error.issues[0].message);
      return;
    }
    renamingInProgress.current = true;
    try {
      const provider = await ensureProvider();
      const newPath =
        currentPath === "/" ? `/${trimmed}` : `${currentPath}/${trimmed}`;
      await provider.moveFile(renamingPath, newPath);
      toast.success(`Renamed to ${trimmed}`);
      await refreshFiles();
    } catch (err: unknown) {
      toast.error(`Failed to rename: ${extractError(err)}`);
    } finally {
      renamingInProgress.current = false;
      actions.cancelRename(paneId);
    }
  }, [
    paneId,
    renamingPath,
    renameValue,
    files,
    currentPath,
    ensureProvider,
    refreshFiles,
  ]);

  // ── New file / folder ────────────────────────────────────────────────────
  const handleNewFolder = useCallback(
    () => newFolderModal.show(),
    [newFolderModal],
  );
  const handleNewFile = useCallback(() => newFileModal.show(), [newFileModal]);

  const confirmNewFolder = useCallback(
    async (name: string) => {
      const newPath =
        currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      try {
        const provider = await ensureProvider();
        await provider.mkdir(newPath);
        toast.success(`Created folder ${name}`);
        await refreshFiles();
      } catch (err: unknown) {
        toast.error(`Failed to create folder: ${extractError(err)}`);
      }
    },
    [currentPath, ensureProvider, refreshFiles],
  );

  const confirmNewFile = useCallback(
    async (name: string) => {
      const newPath =
        currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      try {
        const provider = await ensureProvider();
        await provider.writeFile(newPath, new Uint8Array(0));
        toast.success(`Created file ${name}`);
        await refreshFiles();
      } catch (err: unknown) {
        toast.error(`Failed to create file: ${extractError(err)}`);
      }
    },
    [currentPath, ensureProvider, refreshFiles],
  );

  // ── Delete ───────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (file: FileItem) => {
    setDeleteConfirm({ files: [file], selectedNames: null });
  }, []);

  const handleDeleteSelected = useCallback(async () => {
    const selected = [...selectedFiles]
      .map((name) => files.find((f) => f.name === name))
      .filter((f): f is FileItem => !!f);
    if (selected.length === 0) return;
    setDeleteConfirm({
      files: selected,
      selectedNames: new Set(selectedFiles),
    });
  }, [selectedFiles, files]);

  const confirmDeleteAction = useCallback(async () => {
    if (!deleteConfirm) return;
    const { files: toDelete } = deleteConfirm;
    setDeleteConfirm(null);
    let deleted = 0;
    let failed = 0;
    try {
      const provider = await ensureProvider();
      for (const file of toDelete) {
        try {
          await provider.delete(file.path, true);
          deleted++;
        } catch {
          failed++;
        }
      }
    } catch (err: unknown) {
      toast.error(`Delete failed: ${extractError(err)}`);
      return;
    }
    if (deleted > 0) {
      toast.success(`Deleted ${deleted} item${deleted > 1 ? "s" : ""}`);
      await refreshFiles();
    }
    if (failed > 0) {
      toast.error(`Failed to delete ${failed} item${failed > 1 ? "s" : ""}`);
    }
  }, [deleteConfirm, ensureProvider, refreshFiles]);

  // ── Upload / Download ────────────────────────────────────────────────────
  const handleUpload = useCallback(
    async (fileList: FileList) => {
      if (fileList.length === 0) return;
      try {
        const provider = await ensureProvider();
        let uploaded = 0;
        let failed = 0;
        for (const file of Array.from(fileList)) {
          try {
            const data = new Uint8Array(await file.arrayBuffer());
            const remotePath =
              currentPath === "/"
                ? `/${file.name}`
                : `${currentPath}/${file.name}`;
            await provider.writeFile(remotePath, data);
            uploaded++;
          } catch {
            failed++;
          }
        }
        if (uploaded > 0) {
          toast.success(`Uploaded ${uploaded} file${uploaded > 1 ? "s" : ""}`);
          await refreshFiles();
        }
        if (failed > 0) {
          toast.error(
            `Failed to upload ${failed} file${failed > 1 ? "s" : ""}`,
          );
        }
      } catch (err: unknown) {
        toast.error(`Upload failed: ${extractError(err)}`);
      }
    },
    [currentPath, ensureProvider, refreshFiles],
  );

  const handleDownload = useCallback(
    async (file: FileItem) => {
      try {
        const provider = await ensureProvider();
        const { save } = await import("@tauri-apps/plugin-dialog");
        const localPath = await save({
          defaultPath: file.name,
          title: "Save File",
        });
        if (!localPath) return;
        await provider.download(file.path, localPath);
        toast.success(`Downloaded ${file.name}`);
      } catch (err: unknown) {
        toast.error(`Download failed: ${extractError(err)}`);
      }
    },
    [ensureProvider],
  );

  // ── Clipboard ────────────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    const paths = [...selectedFiles].map((name) => {
      const file = files.find((f) => f.name === name);
      return file?.path || `${currentPath}/${name}`;
    });
    if (paths.length === 0) return;
    const srcDirect = hostId.startsWith("direct_")
      ? { host: hostAddress, port: hostPort, username: hostUsername }
      : undefined;
    useSftpStore.getState().setClipboard(hostId, paths, "copy", srcDirect);
    toast.info(`Copied ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [
    selectedFiles,
    files,
    currentPath,
    hostId,
    hostAddress,
    hostPort,
    hostUsername,
  ]);

  const handleCut = useCallback(() => {
    const paths = [...selectedFiles].map((name) => {
      const file = files.find((f) => f.name === name);
      return file?.path || `${currentPath}/${name}`;
    });
    if (paths.length === 0) return;
    const srcDirect = hostId.startsWith("direct_")
      ? { host: hostAddress, port: hostPort, username: hostUsername }
      : undefined;
    useSftpStore.getState().setClipboard(hostId, paths, "cut", srcDirect);
    toast.info(`Cut ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [
    selectedFiles,
    files,
    currentPath,
    hostId,
    hostAddress,
    hostPort,
    hostUsername,
  ]);

  const handlePaste = useCallback(async () => {
    const { clipboard, clipboardMode } = useSftpStore.getState();
    if (!clipboard || !clipboardMode) return;
    try {
      const provider = await ensureProvider();
      let processed = 0;
      let failed = 0;
      for (const srcPath of clipboard.paths) {
        try {
          const fileName = srcPath.split(/[/\\]/).pop() || srcPath;
          const destPath =
            currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
          if (clipboardMode === "cut") {
            await provider.moveFile(srcPath, destPath);
          } else {
            await provider.copyFile(srcPath, destPath);
          }
          processed++;
        } catch {
          failed++;
        }
      }
      if (processed > 0) {
        toast.success(
          `${clipboardMode === "cut" ? "Moved" : "Copied"} ${processed} item${processed > 1 ? "s" : ""}`,
        );
        await refreshFiles();
      }
      if (failed > 0) {
        toast.error(
          `Failed to ${clipboardMode === "cut" ? "move" : "copy"} ${failed} item${failed > 1 ? "s" : ""}`,
        );
      }
      useSftpStore.getState().clearClipboard();
    } catch (err: unknown) {
      toast.error(`Paste failed: ${extractError(err)}`);
    }
  }, [currentPath, ensureProvider, refreshFiles]);

  // ── File drop ────────────────────────────────────────────────────────────
  const executeFileDrop = useCallback(
    async (
      dragFiles: FileItem[],
      sourceHostId: string,
      destHostId: string,
      destDirPath: string,
      overrides?: Map<
        string,
        { action: "replace" | "rename" | "auto" | "skip"; newName?: string }
      >,
      sourceDirect?: { host?: string; port?: number; username?: string },
      _sourcePaneId?: string,
    ) => {
      try {
        const provider = await ensureProvider();
        const isSameHost = sourceHostId === destHostId;
        let processed = 0;
        let failed = 0;
        for (const file of dragFiles) {
          const override = overrides?.get(file.path);
          if (override?.action === "skip") continue;
          try {
            const destName =
              override?.action === "auto"
                ? `${file.name} (copy)`
                : override?.action === "rename" && override.newName
                  ? override.newName
                  : file.name;
            const destPath =
              destDirPath === "/"
                ? `/${destName}`
                : `${destDirPath}/${destName}`;
            if (isSameHost && !sourceDirect) {
              await provider.moveFile(file.path, destPath);
            } else {
              await provider.copyFile(file.path, destPath);
            }
            processed++;
          } catch {
            failed++;
          }
        }
        if (processed > 0) {
          toast.success(
            `${isSameHost ? "Moved" : "Copied"} ${processed} item${processed > 1 ? "s" : ""}`,
          );
          await refreshFiles();
        }
        if (failed > 0) {
          toast.error(
            `Failed to ${isSameHost ? "move" : "copy"} ${failed} item${failed > 1 ? "s" : ""}`,
          );
        }
      } catch (err: unknown) {
        toast.error(`File drop failed: ${extractError(err)}`);
      }
    },
    [ensureProvider, refreshFiles],
  );

  const executePaste = useCallback(
    async (
      overrides?: Map<
        string,
        { action: "replace" | "rename" | "auto" | "skip"; newName?: string }
      >,
    ) => {
      const { clipboard, clipboardMode } = useSftpStore.getState();
      if (!clipboard || !clipboardMode) return;
      try {
        const provider = await ensureProvider();
        let processed = 0;
        let failed = 0;
        for (const srcPath of clipboard.paths) {
          const override = overrides?.get(srcPath);
          if (override?.action === "skip") continue;
          try {
            const fileName = srcPath.split(/[/\\]/).pop() || srcPath;
            const destName =
              override?.action === "auto"
                ? `${fileName} (copy)`
                : override?.action === "rename" && override.newName
                  ? override.newName
                  : fileName;
            const destPath =
              currentPath === "/"
                ? `/${destName}`
                : `${currentPath}/${destName}`;
            if (clipboardMode === "cut") {
              await provider.moveFile(srcPath, destPath);
            } else {
              await provider.copyFile(srcPath, destPath);
            }
            processed++;
          } catch {
            failed++;
          }
        }
        if (processed > 0) {
          toast.success(
            `${clipboardMode === "cut" ? "Moved" : "Copied"} ${processed} item${processed > 1 ? "s" : ""}`,
          );
          await refreshFiles();
        }
        if (failed > 0) {
          toast.error(
            `Failed to ${clipboardMode === "cut" ? "move" : "copy"} ${failed} item${failed > 1 ? "s" : ""}`,
          );
        }
        useSftpStore.getState().clearClipboard();
      } catch (err: unknown) {
        toast.error(`Paste failed: ${extractError(err)}`);
      }
    },
    [currentPath, ensureProvider, refreshFiles],
  );

  return {
    renameInputRef,
    renamingPath,
    renameValue,
    newFileModal,
    newFolderModal,
    startRename,
    commitRename,
    handleNewFile,
    handleNewFolder,
    confirmNewFile,
    confirmNewFolder,
    handleDelete,
    handleDeleteSelected,
    confirmDeleteAction,
    deleteConfirm,
    setDeleteConfirm,
    handleUpload,
    handleDownload,
    handleCopy,
    handleCut,
    handlePaste,
    executeFileDrop,
    executePaste,
  };
}
