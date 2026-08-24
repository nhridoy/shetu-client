import { pointerIntersection } from "@dnd-kit/collision";
import { useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { FileIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import FileBrowserList from "@/components/sftp/browser/FileBrowserList";
import {
  DragOverOverlay,
  DropTargetOverlay,
  ErrorBar,
} from "@/components/sftp/browser/FileBrowserOverlays";
import PasteConflictDialog from "@/components/sftp/browser/PasteConflictDialog";
import PermissionsDialog from "@/components/sftp/browser/PermissionsDialog";
import FileBrowserStatusBar from "@/components/sftp/browser/shared/FileBrowserStatusBar";
import FileBrowserToolbar from "@/components/sftp/browser/shared/FileBrowserToolbar";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import PromptDialog from "@/components/ui/PromptDialog";
import { useFileKeyboardShortcuts } from "@/hooks/sftp/useFileKeyboardShortcuts";
import { useFileOperations } from "@/hooks/sftp/useFileOperations";
import { useMarqueeSelection } from "@/hooks/sftp/useMarqueeSelection";
import { useSortedFiles } from "@/hooks/sftp/useSortedFiles";
import { useTauriDragDrop } from "@/hooks/sftp/useTauriDragDrop";
import { extractError } from "@/lib/common/extractError";
import { classifyFilePath } from "@/lib/sftp/fileKind";
import type { RemoteFileProviderImpl } from "@/lib/sftp/remoteFs";
import {
  fileBrowserActions,
  useFileBrowserStore,
} from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface FileBrowserProps {
  paneId?: string;
  hostId: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  onFileSelect?: (file: FileItem) => void;
  onOpenInEditor?: (file: FileItem | null) => void;
}

export default function FileBrowser({
  paneId = "standalone",
  hostId,
  hostAddress,
  hostPort,
  hostUsername,
  onFileSelect,
  onOpenInEditor,
}: FileBrowserProps) {
  // ── Store ────────────────────────────────────────────────────────────────
  const paneState = useFileBrowserStore((s) => s.panes[paneId]);
  const activePaneId = useSftpStore((s) => s.activePaneId);
  const getOrCreatePane = useFileBrowserStore((s) => s.getOrCreatePane);

  // Initialize pane on first render
  const initialized = useRef(false);
  if (!initialized.current) {
    // Reset to root only when the connection identity changed (fresh connect,
    // different host, or local <-> remote switch). A plain remount after a
    // module switch must keep the current path, files, and history.
    const store = useFileBrowserStore.getState();
    const existing = store.panes[paneId];
    const connKey = `host:${hostId}`;
    if (existing) {
      if (existing.connectionKey !== connKey) {
        store.updatePane(paneId, {
          currentPath: "/",
          files: [],
          selectedFiles: new Set<string>(),
          error: null,
          isLoading: false,
          searchQuery: "",
          renamingPath: null,
          pasteConflicts: null,
          pendingDrop: null,
          initialized: false,
          sortedFiles: [],
          history: ["/"],
          historyIndex: 0,
          connectionKey: connKey,
        });
      }
    } else {
      getOrCreatePane(paneId, "/");
      useFileBrowserStore
        .getState()
        .updatePane(paneId, { connectionKey: connKey });
    }
    initialized.current = true;
  }

  const files = paneState?.files ?? [];
  const currentPath = paneState?.currentPath ?? "/";
  const isLoading = paneState?.isLoading ?? false;
  const error = paneState?.error ?? null;
  const selectedFiles = paneState?.selectedFiles ?? new Set<string>();
  const viewMode = paneState?.viewMode ?? "list";
  const showHidden = paneState?.showHidden ?? false;
  const sortField = paneState?.sortField ?? "name";
  const sortDirection = paneState?.sortDirection ?? "asc";
  const activeTransfers = useSftpStore(
    (s) =>
      s.transfers.filter((t) => t.status === "pending" || t.status === "active")
        .length,
  );
  const scanning = useSftpStore((s) => s.transferScanning);
  const searchQuery = paneState?.searchQuery ?? "";
  const recursiveSearch = paneState?.recursiveSearch ?? false;
  const pasteConflicts = paneState?.pasteConflicts ?? null;
  const pendingDrop = paneState?.pendingDrop ?? null;
  const history = paneState?.history ?? ["/"];
  const historyIndex = paneState?.historyIndex ?? 0;

  const fileDragState = useSftpStore((s) => s.fileDragState);
  const pendingFileDrop = useSftpStore((s) => s.pendingFileDrop);
  const setPendingFileDrop = useSftpStore((s) => s.setPendingFileDrop);

  const actions = fileBrowserActions;

  // ── Operations (stub until SSH provider is built) ────────────────────────
  const ops = useFileOperations({
    paneId,
    hostId,
    hostAddress,
    hostPort,
    hostUsername,
    onFileSelect,
  });

  // ── Sorted files ─────────────────────────────────────────────────────────
  const sortedFiles = useSortedFiles({
    files,
    showHidden,
    searchQuery,
    sortField,
    sortDirection,
  });

  // ── Component-only state ─────────────────────────────────────────────────
  const [isDropTarget, setIsDropTarget] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Connection steps animation ──────────────────────────────────────────
  const [connStep, setConnStep] = useState<number | null>(null);
  const stepsStarted = useRef(false);
  useEffect(() => {
    if (stepsStarted.current) return;
    if (files.length > 0 || error) {
      setConnStep(null);
      return;
    }
    stepsStarted.current = true;
    const step = (i: number, delay: number) =>
      new Promise<void>((r) =>
        setTimeout(() => {
          setConnStep(i);
          r();
        }, delay),
      );
    (async () => {
      await step(0, 200);
      await step(1, 400);
      await step(2, 350);
      await step(3, 300);
    })();
  }, [files.length, error]);

  // ── Marquee selection ────────────────────────────────────────────────────
  const marquee = useMarqueeSelection({
    paneId,
    containerRef,
    selectedFiles,
    onClearSelection: useCallback(
      () => actions.clearSelection(paneId),
      [paneId],
    ),
  });

  // ── Load files on mount and when path changes ──────────────────────────
  const loadRemoteFilesRef = useRef(ops.loadRemoteFiles);
  loadRemoteFilesRef.current = ops.loadRemoteFiles;
  useEffect(() => {
    loadRemoteFilesRef.current(currentPath);
  }, [currentPath]);

  const handleTauriDrop = useCallback(
    async (paths: string[], destDir: string) => {
      if (paths.length === 0) return;
      try {
        const provider = await ops.ensureProvider();
        const { invoke } = await import("@tauri-apps/api/core");

        const dropFiles: FileItem[] = [];
        for (const filePath of paths) {
          const name = filePath.split(/[/\\]/).pop() || filePath;
          const isDir = await invoke<boolean>("is_directory", {
            path: filePath,
          }).catch(() => false);
          const size = isDir
            ? 0
            : await invoke<number>("get_file_size", {
                path: filePath,
              }).catch(() => 0);
          dropFiles.push({
            name,
            path: filePath,
            type: isDir ? "directory" : "file",
            size,
            permissions: "",
            owner: "",
            group: "",
            modifiedAt: new Date().toISOString(),
            isHidden: name.startsWith("."),
          });
        }

        let destFiles: FileItem[];
        try {
          destFiles = await provider.listFiles(destDir);
        } catch {
          destFiles = [];
        }
        const destNames = new Set(destFiles.map((f) => f.name));
        const conflicts = dropFiles.filter((f) => destNames.has(f.name));

        if (conflicts.length > 0) {
          actions.setPasteConflicts(
            paneId,
            conflicts.map((f) => ({
              srcPath: f.path,
              dstPath: destDir === "/" ? `/${f.name}` : `${destDir}/${f.name}`,
              dstName: f.name,
            })),
          );
          actions.setPendingDrop(paneId, {
            files: dropFiles,
            destDirPath: destDir,
            mode: "copy",
            sourceHostId: "local",
          });
          return;
        }

        const { transferFiles, LocalFileProvider } = await import(
          "@/lib/sftp/fileTransfer"
        );
        await transferFiles({
          source: new LocalFileProvider("local"),
          dest: provider,
          files: dropFiles,
          destPath: destDir,
          mode: "copy",
          sessionId: paneId,
        });
        await ops.refreshFiles();
      } catch (err) {
        toast.error(
          `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [paneId, ops],
  );

  const tauriDragDrop = useTauriDragDrop({
    paneId,
    currentPath,
    hostId,
    onDrop: handleTauriDrop,
  });

  // ── Drag & drop (OS drops arrive via useTauriDragDrop paths) ─────────────
  const droppable = useDroppable({
    id: `file-drop-${paneId}`,
    data: { type: "file-drop", paneId, hostId, path: currentPath },
    collisionDetector: pointerIntersection,
  });

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      droppable.ref(node);
    },
    [droppable.ref],
  );

  useDragDropMonitor({
    onDragOver(event) {
      const source = event.operation.source;
      const target = event.operation.target;
      if (
        source?.data?.type === "file-drag" &&
        target?.data?.type === "file-drop"
      ) {
        const sourceHostId = source.data.hostId as string;
        const destHostId = target.data.hostId as string;
        const dragFiles = source.data.files as FileItem[];
        const destDirPath = target.data.path as string;
        const srcDir =
          dragFiles[0]?.path.split("/").slice(0, -1).join("/") || "/";
        const isNoop = sourceHostId === destHostId && srcDir === destDirPath;
        setIsDropTarget(
          !isNoop &&
            destDirPath === currentPath &&
            target.data.paneId === paneId,
        );
      } else {
        setIsDropTarget(false);
      }
    },
    onDragEnd() {
      setIsDropTarget(false);
    },
  });

  useEffect(() => {
    if (!pendingFileDrop) return;
    if (pendingFileDrop.destPaneId !== paneId) return;

    (async () => {
      const {
        files: dragFiles,
        sourceHostId,
        destDirPath,
        sourcePaneId,
      } = pendingFileDrop;

      if (!dragFiles || !destDirPath) {
        setPendingFileDrop(null);
        return;
      }

      let destFiles: FileItem[];
      try {
        const provider = await ops.ensureProvider();
        destFiles = await provider.listFiles(destDirPath);
      } catch {
        destFiles = [];
      }
      const destNames = new Set(destFiles.map((f) => f.name));
      const conflicts = dragFiles.filter((f) => destNames.has(f.name));

      if (conflicts.length > 0) {
        actions.setPasteConflicts(
          paneId,
          conflicts.map((f) => ({
            srcPath: f.path,
            dstPath:
              destDirPath === "/" ? `/${f.name}` : `${destDirPath}/${f.name}`,
            dstName: f.name,
          })),
        );
        actions.setPendingDrop(paneId, {
          files: dragFiles,
          destDirPath,
          mode: "copy",
          sourceHostId: sourceHostId || undefined,
          sourcePaneId: sourcePaneId || undefined,
          sourceDirect: pendingFileDrop.sourceDirect,
        });
      } else {
        await ops.executeFileDrop(
          dragFiles,
          sourceHostId || "",
          pendingFileDrop.destHostId || "",
          destDirPath,
          undefined,
          pendingFileDrop.sourceDirect,
          sourcePaneId,
        );
      }
    })();

    setPendingFileDrop(null);
  }, [
    pendingFileDrop,
    paneId,
    ops.executeFileDrop,
    ops.ensureProvider,
    setPendingFileDrop,
  ]);

  // ── Navigation ───────────────────────────────────────────────────────────
  const navigateBack = useCallback(
    () => actions.navigateBack(paneId),
    [paneId],
  );
  const navigateForward = useCallback(
    () => actions.navigateForward(paneId),
    [paneId],
  );

  // ── File preview ───────────────────────────────────────────────────────
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useFileKeyboardShortcuts({
    activePaneId,
    paneId,
    selectedFiles,
    files,
    onCopy: ops.handleCopy,
    onCut: ops.handleCut,
    onPaste: ops.handlePaste,
    onDelete: ops.handleDeleteSelected,
    onRename: ops.startRename,
    onRefresh: () => ops.refreshFiles(),
    onNavigateUp: () => actions.navigateUp(paneId),
    onClearSelection: () => actions.clearSelection(paneId),
    onNewFile: ops.handleNewFile,
    onSelectAll: () =>
      useFileBrowserStore.getState().updatePane(paneId, {
        selectedFiles: new Set(sortedFiles.map((f) => f.name)),
      }),
    deleteConfirm: ops.deleteConfirm,
    pasteConflicts,
    onConfirmDelete: ops.confirmDeleteAction,
    onDismissDeleteConfirm: () => ops.setDeleteConfirm(null),
    onDismissPasteConflicts: () => actions.setPasteConflicts(paneId, null),
  });

  // ── Compose actions for FileBrowserList ──────────────────────────────────
  const listActions = {
    handleDoubleClick: (file: FileItem) => {
      if (file.type === "directory") {
        actions.navigateTo(paneId, file.path);
      } else {
        onFileSelect?.(file);
      }
    },
    handleSelect: (
      fileName: string,
      isMultiSelect: boolean,
      isShift?: boolean,
      allFiles?: FileItem[],
    ) => {
      actions.selectFile(
        paneId,
        fileName,
        isMultiSelect,
        !!isShift,
        allFiles ?? sortedFiles,
      );
    },
    handleCopy: ops.handleCopy,
    handleCut: ops.handleCut,
    handlePaste: ops.handlePaste,
    handleDelete: ops.handleDelete,
    handleDeleteSelected: ops.handleDeleteSelected,
    handleNewFolder: ops.handleNewFolder,
    handleNewFile: ops.handleNewFile,
    handleDownload: ops.handleDownload,
    onPermissions: ops.handlePermissions,
    onOpenInEditor,
    onPreview: (file: FileItem) => setPreviewFile(file),
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: drag-and-drop container needs div
    <div
      ref={setContainerRef}
      role="region"
      aria-label="File browser"
      className="h-full flex flex-col bg-dark-900 relative"
      data-drop-target-path={currentPath}
      data-drop-target-pane={paneId}
      data-drop-target-host={hostId}
      onMouseDown={marquee.handleMouseDown}
      onMouseMove={marquee.handleMouseMove}
      onMouseUp={marquee.handleMouseUp}
    >
      <DragOverOverlay
        isDragOver={tauriDragDrop.isDragOver}
        fileDragState={fileDragState}
      />
      <DropTargetOverlay
        isDropTarget={isDropTarget}
        fileDragState={fileDragState}
        hostId={hostId}
      />

      {connStep !== null && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-dark-900/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            {[
              "Establishing SSH connection...",
              "Opening SFTP channel...",
              "Authenticating...",
              "Loading directory...",
            ].map((text, i) => (
              <div
                key={text}
                className={`flex items-center gap-2 text-sm transition-opacity duration-300 ${
                  i <= connStep
                    ? "opacity-100 text-dark-200"
                    : "opacity-30 text-dark-500"
                }`}
              >
                {i < connStep ? (
                  <span className="text-green-400">✓</span>
                ) : i === connStep ? (
                  <span className="w-3 h-3 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="w-3 h-3" />
                )}
                {text}
              </div>
            ))}
          </div>
        </div>
      )}

      <FileBrowserToolbar
        currentPath={currentPath}
        pathLabel="Remote path"
        searchQuery={searchQuery}
        showHidden={showHidden}
        viewMode={viewMode}
        onNavigateTo={(path) => {
          const normalized = path.startsWith("/") ? path : `/${path}`;
          actions.navigateTo(paneId, normalized);
        }}
        onNavigateRoot={() => actions.navigateTo(paneId, "/")}
        onNavigateBack={navigateBack}
        onNavigateForward={navigateForward}
        onNavigateUp={() => actions.navigateUp(paneId)}
        onRefresh={() => ops.refreshFiles()}
        onNewFolder={ops.handleNewFolder}
        onSearchChange={(q) => {
          actions.setSearchQuery(paneId, q);
          if (recursiveSearch && q.trim()) {
            ops.handleServerSearch(q);
          }
        }}
        onShowHiddenChange={(v) => actions.setShowHidden(paneId, v)}
        onViewModeChange={(m) => actions.setViewMode(paneId, m)}
        recursiveSearch={recursiveSearch}
        onRecursiveSearchChange={(v) => {
          actions.setRecursiveSearch(paneId, v);
          if (!v) {
            ops.refreshFiles();
          }
        }}
        showBackForward
        canNavigateBack={historyIndex > 0}
        canNavigateForward={historyIndex < history.length - 1}
        beforeActions={
          <Button size="sm" onClick={() => ops.handleUpload()}>
            Upload
          </Button>
        }
        onDisconnect={ops.disconnect}
      />

      <ErrorBar error={error} setError={() => actions.clearError(paneId)} />

      <FileBrowserList
        isLoading={isLoading}
        sortedFiles={sortedFiles}
        viewMode={viewMode}
        searchQuery={searchQuery}
        sortField={sortField}
        sortDirection={sortDirection}
        setSortField={(f) => actions.setSortField(paneId, f)}
        setSortDirection={(fn) => {
          const next = typeof fn === "function" ? fn(sortDirection) : fn;
          useFileBrowserStore.getState().updatePane(paneId, {
            sortDirection: next,
          });
        }}
        paneId={paneId}
        hostId={hostId}
        hostAddress={hostAddress}
        hostUsername={hostUsername}
        selectedFiles={selectedFiles}
        clipboard={useSftpStore.getState().clipboard}
        renamingPath={paneState?.renamingPath ?? null}
        renameValue={paneState?.renameValue ?? ""}
        renameInputRef={ops.renameInputRef}
        commitRename={ops.commitRename}
        setRenamingPath={(p) => actions.setRenamingPath(paneId, p)}
        setRenameValue={(v) => actions.setRenameValue(paneId, v)}
        actions={listActions}
      />

      <FileBrowserStatusBar
        totalCount={sortedFiles.length}
        selectedCount={selectedFiles.size}
        activeTransfers={activeTransfers}
        scanning={scanning}
      />

      {marquee.isDragging && marquee.start && marquee.current && (
        <div
          data-marquee
          className="fixed z-50 border border-primary-500 bg-primary-500/10 pointer-events-none"
          style={{
            left: Math.min(marquee.start.x, marquee.current.x),
            top: Math.min(marquee.start.y, marquee.current.y),
            width: Math.abs(marquee.current.x - marquee.start.x),
            height: Math.abs(marquee.current.y - marquee.start.y),
          }}
        />
      )}

      {pasteConflicts && (
        <PasteConflictDialog
          conflicts={pasteConflicts}
          onConfirm={(overrides) => {
            actions.setPasteConflicts(paneId, null);
            if (pendingDrop) {
              ops.executeFileDrop(
                pendingDrop.files as FileItem[],
                pendingDrop.sourceHostId ?? "",
                hostId,
                pendingDrop.destDirPath,
                overrides,
                pendingDrop.sourceDirect,
                pendingDrop.sourcePaneId,
              );
              actions.setPendingDrop(paneId, null);
            } else {
              ops.executePaste(overrides);
            }
          }}
          onCancel={() => {
            actions.setPasteConflicts(paneId, null);
            actions.setPendingDrop(paneId, null);
            if (useSftpStore.getState().clipboardMode === "cut")
              useSftpStore.getState().clearClipboard();
          }}
        />
      )}

      {ops.newFileModal.open && (
        <PromptDialog
          open={ops.newFileModal.open}
          title="New File"
          placeholder="filename.txt"
          confirmLabel="Create"
          onConfirm={ops.confirmNewFile}
          onClose={ops.newFileModal.hide}
        />
      )}

      {ops.newFolderModal.open && (
        <PromptDialog
          open={ops.newFolderModal.open}
          title="New Folder"
          placeholder="folder name"
          confirmLabel="Create"
          onConfirm={ops.confirmNewFolder}
          onClose={ops.newFolderModal.hide}
        />
      )}

      {ops.deleteConfirm && (
        <Modal
          open
          onClose={
            ops.deleteConfirm.isDeleting
              ? () => {}
              : () => ops.setDeleteConfirm(null)
          }
          title="Confirm Delete"
          maxWidth="max-w-sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-dark-300">
              {ops.deleteConfirm.isDeleting ? (
                <>
                  Deleting{" "}
                  <span className="text-white font-medium">
                    {(ops.deleteConfirm.deletingIndex ?? 0) + 1}/
                    {ops.deleteConfirm.files.length}
                  </span>{" "}
                  items…
                </>
              ) : ops.deleteConfirm.files.length === 1 ? (
                <>
                  Are you sure you want to delete{" "}
                  <span className="text-white font-medium">
                    {ops.deleteConfirm.files[0].name}
                  </span>
                  ?
                </>
              ) : (
                <>
                  Are you sure you want to delete{" "}
                  <span className="text-white font-medium">
                    {ops.deleteConfirm.files.length} items
                  </span>
                  ?
                </>
              )}
            </p>
            {ops.deleteConfirm.isDeleting && (
              <div className="w-full bg-dark-700 rounded-full h-1.5">
                <div
                  className="bg-red-500 h-1.5 rounded-full transition-all duration-200"
                  style={{
                    width: `${(((ops.deleteConfirm.deletingIndex ?? 0) + 1) / ops.deleteConfirm.files.length) * 100}%`,
                  }}
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={ops.deleteConfirm.isDeleting}
                onClick={() => ops.setDeleteConfirm(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={ops.deleteConfirm.isDeleting}
                onClick={ops.confirmDeleteAction}
              >
                {ops.deleteConfirm.isDeleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {ops.permissionsFile && (
        <PermissionsDialog
          open
          file={ops.permissionsFile}
          onConfirm={ops.confirmPermissions}
          onCancel={() => ops.setPermissionsFile(null)}
        />
      )}

      {ops.connectionErrorModal.open && ops.connectionError && (
        <Modal
          open
          onClose={ops.connectionErrorModal.hide}
          title="Connection failed"
          maxWidth="max-w-sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-dark-300">{ops.connectionError}</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={ops.connectionErrorModal.hide}
              >
                Close
              </Button>
              <Button
                onClick={() => {
                  ops.connectionErrorModal.hide();
                  ops.refreshFiles();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {previewFile && (
        <Modal
          open
          onClose={() => setPreviewFile(null)}
          title={previewFile.name}
          maxWidth="max-w-4xl"
        >
          <FilePreviewModal
            file={previewFile}
            ensureProvider={ops.ensureProvider}
            onClose={() => setPreviewFile(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function FilePreviewModal({
  file,
  ensureProvider,
  onClose,
}: {
  file: FileItem;
  ensureProvider: () => Promise<RemoteFileProviderImpl>;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const kind = classifyFilePath(file.path);

        if (kind === "image") {
          const provider = await ensureProvider();
          const data = await provider.readFile(file.path);
          if (!cancelled) {
            const blob = new Blob([new Uint8Array(data)]);
            setImageUrl(URL.createObjectURL(blob));
            setLoading(false);
          }
        } else if (kind === "code" || kind === "markdown") {
          const provider = await ensureProvider();
          const data = await provider.readFile(file.path);
          if (!cancelled) {
            const text = new TextDecoder().decode(data);
            setContent(text);
            setLoading(false);
          }
        } else {
          if (!cancelled) {
            setError("Preview not available for this file type");
            setLoading(false);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(extractError(err));
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [file.path, ensureProvider, imageUrl]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-dark-400">
        Loading preview...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <FileIcon className="w-12 h-12 text-dark-500" />
        <p className="text-dark-400">{error}</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  if (imageUrl) {
    return (
      <div className="flex items-center justify-center p-4 bg-dark-950 rounded">
        <img
          src={imageUrl}
          alt={file.name}
          className="max-w-full max-h-[60vh] object-contain"
        />
      </div>
    );
  }

  if (content !== null) {
    return (
      <div className="h-[60vh] overflow-auto bg-dark-950 rounded p-4">
        <pre className="text-sm text-dark-200 font-mono whitespace-pre-wrap break-words">
          {content}
        </pre>
      </div>
    );
  }

  return null;
}
