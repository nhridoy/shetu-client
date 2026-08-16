import { pointerIntersection } from "@dnd-kit/collision";
import { useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import FileBrowserList from "@/components/sftp/browser/FileBrowserList";
import {
  DragOverOverlay,
  DropTargetOverlay,
  ErrorBar,
} from "@/components/sftp/browser/FileBrowserOverlays";
import PasteConflictDialog from "@/components/sftp/browser/PasteConflictDialog";
import FileBrowserStatusBar from "@/components/sftp/browser/shared/FileBrowserStatusBar";
import FileBrowserToolbar from "@/components/sftp/browser/shared/FileBrowserToolbar";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useFileKeyboardShortcuts } from "@/hooks/sftp/useFileKeyboardShortcuts";
import { useFileOperations } from "@/hooks/sftp/useFileOperations";
import { useSortedFiles } from "@/hooks/sftp/useSortedFiles";
import { useTauriDragDrop } from "@/hooks/sftp/useTauriDragDrop";
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
}

export default function FileBrowser({
  paneId = "standalone",
  hostId,
  hostAddress,
  hostPort,
  hostUsername,
  onFileSelect,
}: FileBrowserProps) {
  // ── Store ────────────────────────────────────────────────────────────────
  const paneState = useFileBrowserStore((s) => s.panes[paneId]);
  const activePaneId = useFileBrowserStore((s) => s.activePaneId);
  const getOrCreatePane = useFileBrowserStore((s) => s.getOrCreatePane);

  // Initialize pane on first render
  const initialized = useRef(false);
  if (!initialized.current) {
    getOrCreatePane(paneId, "/");
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
  const searchQuery = paneState?.searchQuery ?? "";
  const pasteConflicts = paneState?.pasteConflicts ?? null;
  const pendingDrop = paneState?.pendingDrop ?? null;

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
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Tauri OS drag-drop ───────────────────────────────────────────────────
  const tauriDragDrop = useTauriDragDrop({
    paneId,
    currentPath,
    hostId,
  });

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0)
        ops.handleUpload(e.dataTransfer.files);
    },
    [ops.handleUpload],
  );

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
        setIsDropTarget(!isNoop && destDirPath === currentPath);
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
    ops.executeFileDrop(
      pendingFileDrop.files,
      pendingFileDrop.sourceHostId || "",
      pendingFileDrop.destHostId || "",
      pendingFileDrop.destDirPath || "/",
      undefined,
      pendingFileDrop.sourceDirect,
      pendingFileDrop.sourcePaneId,
    );
    setPendingFileDrop(null);
  }, [pendingFileDrop, paneId, ops.executeFileDrop, setPendingFileDrop]);

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
    onRefresh: () => actions.loadFiles(paneId, currentPath, async () => []),
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
    handleNewFolder: ops.handleNewFolder,
    handleNewFile: ops.handleNewFile,
    handleDownload: ops.handleDownload,
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DragOverOverlay
        isDragOver={tauriDragDrop.isDragOver || isDragOver}
        fileDragState={fileDragState}
      />
      <DropTargetOverlay
        isDropTarget={isDropTarget}
        fileDragState={fileDragState}
        hostId={hostId}
      />

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
        onNavigateUp={() => actions.navigateUp(paneId)}
        onRefresh={() => actions.loadFiles(paneId, currentPath, async () => [])}
        onNewFolder={ops.handleNewFolder}
        onSearchChange={(q) => actions.setSearchQuery(paneId, q)}
        onShowHiddenChange={(v) => actions.setShowHidden(paneId, v)}
        onViewModeChange={(m) => actions.setViewMode(paneId, m)}
        beforeActions={
          <label className="bg-primary-600 hover:bg-primary-700 text-white px-3 py-1 rounded text-sm cursor-pointer transition-colors">
            Upload
            <input
              type="file"
              className="hidden"
              multiple
              onChange={(e) =>
                e.target.files && ops.handleUpload(e.target.files)
              }
            />
          </label>
        }
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
      />

      {pasteConflicts && (
        <PasteConflictDialog
          conflicts={pasteConflicts}
          onConfirm={(overrides) => {
            actions.setPasteConflicts(paneId, null);
            if (pendingDrop) {
              ops.executeFileDrop(
                pendingDrop.files as FileItem[],
                "",
                hostId,
                pendingDrop.destDirPath,
                overrides,
                undefined,
                undefined,
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

      {ops.deleteConfirm && (
        <Modal
          open
          onClose={() => ops.setDeleteConfirm(null)}
          title="Confirm Delete"
          maxWidth="max-w-sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-dark-300">
              {ops.deleteConfirm.files.length === 1 ? (
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
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => ops.setDeleteConfirm(null)}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={ops.confirmDeleteAction}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
