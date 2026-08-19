import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useModal } from "@/hooks/useModal";
import { extractError } from "@/lib/common/extractError";
import { nameFormSchema } from "@/lib/schema/common/nameFormSchema";
import type { FileProvider } from "@/lib/sftp/fileTransfer";
import {
  getProvider,
  registerProvider,
  unregisterProvider,
} from "@/lib/sftp/providerRegistry";
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
    isDeleting?: boolean;
    deletingIndex?: number;
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
          registerProvider(paneId, provider);
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
    unregisterProvider(paneId);
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
    setDeleteConfirm({ ...deleteConfirm, isDeleting: true, deletingIndex: 0 });
    let deleted = 0;
    let failed = 0;
    try {
      const provider = await ensureProvider();
      for (let i = 0; i < toDelete.length; i++) {
        setDeleteConfirm((prev) =>
          prev ? { ...prev, deletingIndex: i } : null,
        );
        try {
          await provider.delete(toDelete[i].path, true);
          deleted++;
        } catch {
          failed++;
        }
      }
    } catch (err: unknown) {
      const message = `Delete failed: ${extractError(err)}`;
      setError(message, "operation");
      toast.error(message);
      setDeleteConfirm(null);
      return;
    }
    setDeleteConfirm(null);
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
      const { transferFiles, LocalFileProvider } = await import(
        "@/lib/sftp/fileTransfer"
      );
      const paths = await open({
        multiple: true,
        title: "Select files or folders to upload",
      });
      if (!paths || (Array.isArray(paths) && paths.length === 0)) return;

      const filePaths = Array.isArray(paths) ? paths : [paths];
      const provider = await ensureProvider();
      const localProvider = new LocalFileProvider("local");

      // Detect if paths are files or directories
      const uploadFiles: FileItem[] = [];
      for (const filePath of filePaths) {
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const isDir = await localProvider.isDirectory(filePath);
        uploadFiles.push({
          name: fileName,
          path: filePath,
          type: isDir ? "directory" : "file",
          size: 0,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date().toISOString(),
          isHidden: fileName.startsWith("."),
        });
      }

      await transferFiles({
        source: localProvider,
        dest: provider,
        files: uploadFiles,
        destPath: currentPath,
        mode: "copy",
        sessionId: paneId,
      });

      clearError();
      await refreshFiles();
    } catch (err: unknown) {
      const message = `Upload failed: ${extractError(err)}`;
      setError(message, "transfer");
      toast.error(message);
    }
  }, [currentPath, paneId, ensureProvider, refreshFiles, setError, clearError]);

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
        const { transferFiles, LocalFileProvider } = await import(
          "@/lib/sftp/fileTransfer"
        );
        const localPath = await save({
          defaultPath: file.name,
          title: "Save File",
        });
        if (!localPath) return;

        // Use the actual filename from the save dialog path
        const localFileName = localPath.split(/[/\\]/).pop() || file.name;
        const localDir = localPath.split(/[/\\]/).slice(0, -1).join("/") || "/";
        const fileWithName = { ...file, name: localFileName };

        await transferFiles({
          source: provider,
          dest: new LocalFileProvider("local"),
          files: [fileWithName],
          destPath: localDir,
          mode: "copy",
          sessionId: paneId,
        });
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
    useSftpStore.getState().setClipboard(paneId, paths, "copy", srcDirect);
    toast.info(`Copied ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [
    selectedFiles,
    files,
    currentPath,
    hostId,
    hostAddress,
    hostPort,
    hostUsername,
    paneId,
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
    useSftpStore.getState().setClipboard(paneId, paths, "cut", srcDirect);
    toast.info(`Cut ${paths.length} item${paths.length > 1 ? "s" : ""}`);
  }, [
    selectedFiles,
    files,
    currentPath,
    hostId,
    hostAddress,
    hostPort,
    hostUsername,
    paneId,
  ]);

  const handlePaste = useCallback(async () => {
    const { clipboard, clipboardMode } = useSftpStore.getState();
    if (!clipboard || !clipboardMode) return;
    try {
      const { transferFiles, LocalFileProvider } = await import(
        "@/lib/sftp/fileTransfer"
      );
      const provider = await ensureProvider();

      // Determine source provider
      const isLocalSource = clipboard.sourceId === "local";
      let sourceProvider: FileProvider;
      if (isLocalSource) {
        sourceProvider = new LocalFileProvider("local");
      } else {
        // Remote source - get from registry or use current provider
        const sourceFromRegistry = getProvider(clipboard.sourceId);
        sourceProvider = sourceFromRegistry ?? provider;
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
        destFiles = await provider.listFiles(currentPath);
      } catch {
        destFiles = [];
      }
      const destNames = new Set(destFiles.map((f) => f.name));
      const conflicts = sourceFiles.filter((f) => destNames.has(f.name));

      if (conflicts.length > 0) {
        fileBrowserActions.setPasteConflicts(
          paneId,
          conflicts.map((f) => ({
            srcPath: f.path,
            dstPath:
              currentPath === "/" ? `/${f.name}` : `${currentPath}/${f.name}`,
            dstName: f.name,
          })),
        );
        return;
      }

      await transferFiles({
        source: sourceProvider,
        dest: provider,
        files: sourceFiles,
        destPath: currentPath,
        mode: clipboardMode === "cut" ? "move" : "copy",
        sessionId: paneId,
      });

      clearError();
      await refreshFiles();
      useSftpStore.getState().clearClipboard();
    } catch (err: unknown) {
      const message = `Paste failed: ${extractError(err)}`;
      setError(message, "operation");
      toast.error(message);
    }
  }, [currentPath, paneId, ensureProvider, refreshFiles, setError, clearError]);

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
      sourcePaneId?: string,
    ) => {
      try {
        const isCrossProvider =
          sourceHostId !== destHostId || sourceDirect?.host;

        if (isCrossProvider) {
          const { transferFiles, LocalFileProvider } = await import(
            "@/lib/sftp/fileTransfer"
          );

          // Get source provider from registry or create LocalFileProvider
          let sourceProvider = sourcePaneId
            ? getProvider(sourcePaneId)
            : undefined;
          if (!sourceProvider) {
            sourceProvider = new LocalFileProvider(sourceHostId);
          }
          const destProvider = await ensureProvider();

          await transferFiles({
            source: sourceProvider,
            dest: destProvider,
            files: dragFiles,
            destPath: destDirPath,
            mode: "copy",
            sessionId: paneId,
            overrides,
          });
        } else {
          const { transferFiles } = await import("@/lib/sftp/fileTransfer");
          const provider = await ensureProvider();

          await transferFiles({
            source: provider,
            dest: provider,
            files: dragFiles,
            destPath: destDirPath,
            mode: "move",
            sessionId: paneId,
            overrides,
          });
        }
        await refreshFiles();
      } catch (err: unknown) {
        const message = `File drop failed: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [ensureProvider, refreshFiles, setError, paneId],
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
        const { transferFiles, LocalFileProvider } = await import(
          "@/lib/sftp/fileTransfer"
        );
        const provider = await ensureProvider();

        const isLocalSource = clipboard.sourceId === "local";
        let sourceProvider: FileProvider;
        if (isLocalSource) {
          sourceProvider = new LocalFileProvider("local");
        } else {
          const sourceFromRegistry = getProvider(clipboard.sourceId);
          sourceProvider = sourceFromRegistry ?? provider;
        }

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

        await transferFiles({
          source: sourceProvider,
          dest: provider,
          files: sourceFiles,
          destPath: currentPath,
          mode: clipboardMode === "cut" ? "move" : "copy",
          sessionId: paneId,
          overrides,
        });

        clearError();
        await refreshFiles();
        useSftpStore.getState().clearClipboard();
      } catch (err: unknown) {
        const message = `Paste failed: ${extractError(err)}`;
        setError(message, "operation");
        toast.error(message);
      }
    },
    [currentPath, paneId, ensureProvider, refreshFiles, setError, clearError],
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
