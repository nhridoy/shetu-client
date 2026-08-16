import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
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
  const connectionErrorModal = useModal();
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const setError = useSftpStore((s) => s.setError);
  const clearError = useSftpStore((s) => s.clearError);

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
          await useSftpStore.getState().ensureTransferListener();
          clearError();
          return provider;
        } catch (err: unknown) {
          const message = extractError(err, "Connection failed");
          setConnectionError(message);
          setError(message, "connection");
          connectionErrorModal.show();
          throw err;
        } finally {
          connectingRef.current = null;
        }
      })();

      return connectingRef.current;
    }, [
      paneId,
      hostId,
      hostAddress,
      hostPort,
      hostUsername,
      setError,
      clearError,
      connectionErrorModal,
    ]);

  const disconnect = useCallback(async () => {
    providerRef.current = null;
    await invoke("sftp_disconnect", { sessionId: paneId }).catch(() => {});
    actions.resetPane(paneId);
    useSftpStore.getState().disconnectPane(paneId);
  }, [paneId]);

  const refreshFiles = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      const fresh = await provider.listFiles(currentPath);
      actions.setFiles(paneId, fresh);
      clearError();
    } catch {
      // silent fail
    }
  }, [currentPath, paneId, clearError]);

  // Load files for current path — initializes provider if needed
  const loadRemoteFiles = useCallback(
    async (path?: string) => {
      const targetPath = path ?? currentPath;
      try {
        const provider = await ensureProvider();
        const fresh = await provider.listFiles(targetPath);
        actions.setFiles(paneId, fresh);
        clearError();
      } catch {
        // error already handled by ensureProvider
      }
    },
    [currentPath, paneId, ensureProvider, clearError],
  );

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
      clearError();
      await refreshFiles();
    } catch (err: unknown) {
      const message = `Failed to rename: ${extractError(err)}`;
      setError(message, "operation");
      toast.error(message);
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
    setError,
    clearError,
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
        clearError();
        await refreshFiles();
      } catch (err: unknown) {
        const message = `Failed to create folder: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [currentPath, ensureProvider, refreshFiles, setError, clearError],
  );

  const confirmNewFile = useCallback(
    async (name: string) => {
      const newPath =
        currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      try {
        const provider = await ensureProvider();
        await provider.writeFile(newPath, new Uint8Array(0));
        toast.success(`Created file ${name}`);
        clearError();
        await refreshFiles();
      } catch (err: unknown) {
        const message = `Failed to create file: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [currentPath, ensureProvider, refreshFiles, setError, clearError],
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
      const message = `Delete failed: ${extractError(err)}`;
      setError(message, "operation");
      toast.error(message);
      return;
    }
    if (deleted > 0) {
      toast.success(`Deleted ${deleted} item${deleted > 1 ? "s" : ""}`);
      clearError();
      await refreshFiles();
    }
    if (failed > 0) {
      const message = `Failed to delete ${failed} item${failed > 1 ? "s" : ""}`;
      setError(message, "operation");
      toast.error(message);
    }
  }, [deleteConfirm, ensureProvider, refreshFiles, setError, clearError]);

  // ── Upload / Download ────────────────────────────────────────────────────
  const handleUpload = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({
        multiple: true,
        title: "Select files to upload",
      });
      if (!paths || (Array.isArray(paths) && paths.length === 0)) return;

      const filePaths = Array.isArray(paths) ? paths : [paths];
      const provider = await ensureProvider();

      for (const filePath of filePaths) {
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const remotePath =
          currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
        const transferId = crypto.randomUUID();

        useSftpStore.getState().addTransfer({
          id: transferId,
          fileName,
          localPath: filePath,
          remotePath,
          direction: "upload",
          status: "pending",
          progress: 0,
          size: 0,
          transferred: 0,
          sessionId: paneId,
        });

        try {
          await provider.upload(filePath, remotePath, undefined, transferId);
        } catch {
          // Error handled by progress listener marking transfer as error
        }
      }

      clearError();
      await refreshFiles();
    } catch (err: unknown) {
      const message = `Upload failed: ${extractError(err)}`;
      setError(message, "transfer");
      toast.error(message);
    }
  }, [currentPath, paneId, ensureProvider, refreshFiles, setError, clearError]);

  const handleDesktopDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const { writeBinaryFile, BaseDirectory } = await import(
          "@tauri-apps/plugin-fs"
        );
        const provider = await ensureProvider();
        const tempDir = await import("@tauri-apps/api/path").then((m) =>
          m.tempdir(),
        );

        for (const file of files) {
          const tempPath = `${tempDir}/sftp-upload-${crypto.randomUUID()}-${file.name}`;
          const data = new Uint8Array(await file.arrayBuffer());
          await writeBinaryFile(tempPath, data, {
            baseDir: BaseDirectory.Temp,
          });

          const remotePath =
            currentPath === "/"
              ? `/${file.name}`
              : `${currentPath}/${file.name}`;
          const transferId = crypto.randomUUID();

          useSftpStore.getState().addTransfer({
            id: transferId,
            fileName: file.name,
            localPath: tempPath,
            remotePath,
            direction: "upload",
            status: "pending",
            progress: 0,
            size: file.size,
            transferred: 0,
            sessionId: paneId,
          });

          try {
            await provider.upload(tempPath, remotePath, undefined, transferId);
          } catch {
            // Error handled by progress listener
          }

          // Clean up temp file
          await import("@tauri-apps/plugin-fs").then((m) =>
            m
              .removeFile(tempPath, { baseDir: BaseDirectory.Temp })
              .catch(() => {}),
          );
        }

        clearError();
        await refreshFiles();
      } catch (err: unknown) {
        const message = `Upload failed: ${extractError(err)}`;
        setError(message, "transfer");
        toast.error(message);
      }
    },
    [currentPath, paneId, ensureProvider, refreshFiles, setError, clearError],
  );

  // ── Permissions ─────────────────────────────────────────────────────────
  const [permissionsFile, setPermissionsFile] = useState<FileItem | null>(null);

  const handlePermissions = useCallback((file: FileItem) => {
    setPermissionsFile(file);
  }, []);

  const confirmPermissions = useCallback(
    async (mode: number) => {
      if (!permissionsFile) return;
      try {
        const provider = await ensureProvider();
        await provider.chmod(permissionsFile.path, mode);
        toast.success(`Updated permissions for ${permissionsFile.name}`);
        clearError();
        setPermissionsFile(null);
        await refreshFiles();
      } catch (err: unknown) {
        const message = `Failed to change permissions: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [permissionsFile, ensureProvider, refreshFiles, setError, clearError],
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

        const transferId = crypto.randomUUID();
        useSftpStore.getState().addTransfer({
          id: transferId,
          fileName: file.name,
          remotePath: file.path,
          localPath,
          direction: "download",
          status: "pending",
          progress: 0,
          size: file.size,
          transferred: 0,
          sessionId: paneId,
        });

        await provider.download(file.path, localPath, undefined, transferId);
        clearError();
      } catch (err: unknown) {
        const message = `Download failed: ${extractError(err)}`;
        setError(message, "transfer");
        toast.error(message);
      }
    },
    [paneId, ensureProvider, clearError, setError],
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
        clearError();
        await refreshFiles();
      }
      if (failed > 0) {
        const message = `Failed to ${clipboardMode === "cut" ? "move" : "copy"} ${failed} item${failed > 1 ? "s" : ""}`;
        setError(message, "operation");
        toast.error(message);
      }
      useSftpStore.getState().clearClipboard();
    } catch (err: unknown) {
      const message = `Paste failed: ${extractError(err)}`;
      setError(message, "operation");
      toast.error(message);
    }
  }, [currentPath, ensureProvider, refreshFiles, setError, clearError]);

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
        const isCrossProvider =
          sourceHostId !== destHostId || sourceDirect?.host;

        if (isCrossProvider) {
          const { transferFiles, LocalFileProvider } = await import(
            "@/lib/sftp/fileTransfer"
          );
          const sourceProvider = new LocalFileProvider(sourceHostId);
          const destProvider = await ensureProvider();

          await transferFiles({
            source: sourceProvider,
            dest: destProvider,
            files: dragFiles,
            destPath: destDirPath,
            mode: "copy",
            overrides,
          });
        } else {
          const provider = await ensureProvider();
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
              await provider.moveFile(file.path, destPath);
              processed++;
            } catch {
              failed++;
            }
          }
          if (processed > 0) {
            toast.success(`Moved ${processed} item${processed > 1 ? "s" : ""}`);
            clearError();
          }
          if (failed > 0) {
            const message = `Failed to move ${failed} item${failed > 1 ? "s" : ""}`;
            setError(message, "operation");
            toast.error(message);
          }
        }
        await refreshFiles();
      } catch (err: unknown) {
        const message = `File drop failed: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [ensureProvider, refreshFiles, setError, clearError],
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
          clearError();
          await refreshFiles();
        }
        if (failed > 0) {
          const message = `Failed to ${clipboardMode === "cut" ? "move" : "copy"} ${failed} item${failed > 1 ? "s" : ""}`;
          setError(message, "operation");
          toast.error(message);
        }
        useSftpStore.getState().clearClipboard();
      } catch (err: unknown) {
        const message = `Paste failed: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [currentPath, ensureProvider, refreshFiles, setError, clearError],
  );

  // ── Server-side recursive search ─────────────────────────────────────────
  const handleServerSearch = useCallback(
    async (query: string): Promise<FileItem[]> => {
      if (!query.trim()) {
        await loadRemoteFiles();
        return [];
      }
      try {
        const provider = await ensureProvider();
        const results = await provider.search(currentPath, query);
        actions.setFiles(paneId, results);
        return results;
      } catch (err: unknown) {
        const message = `Search failed: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
        return [];
      }
    },
    [currentPath, paneId, ensureProvider, setError, loadRemoteFiles],
  );

  return {
    renameInputRef,
    renamingPath,
    renameValue,
    newFileModal,
    newFolderModal,
    connectionErrorModal,
    connectionError,
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
    handleDesktopDrop,
    handleDownload,
    handleCopy,
    handleCut,
    handlePaste,
    executeFileDrop,
    executePaste,
    loadRemoteFiles,
    refreshFiles,
    permissionsFile,
    setPermissionsFile,
    handlePermissions,
    confirmPermissions,
    ensureProvider,
    handleServerSearch,
    disconnect,
  };
}
