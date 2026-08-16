import { pointerIntersection } from "@dnd-kit/collision";
import { useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { FileIcon } from "@phosphor-icons/react";
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
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    handleNewFolder: ops.handleNewFolder,
    handleNewFile: ops.handleNewFile,
    handleDownload: ops.handleDownload,
    onPermissions: ops.handlePermissions,
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseDown={marquee.handleMouseDown}
      onMouseMove={marquee.handleMouseMove}
      onMouseUp={marquee.handleMouseUp}
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
        onNavigateBack={navigateBack}
        onNavigateForward={navigateForward}
        onNavigateUp={() => actions.navigateUp(paneId)}
        onRefresh={() => ops.refreshFiles()}
        onNewFolder={ops.handleNewFolder}
        onSearchChange={(q) => actions.setSearchQuery(paneId, q)}
        onShowHiddenChange={(v) => actions.setShowHidden(paneId, v)}
        onViewModeChange={(m) => actions.setViewMode(paneId, m)}
        showBackForward
        canNavigateBack={historyIndex > 0}
        canNavigateForward={historyIndex < history.length - 1}
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

      {ops.permissionsFile && (
        <Modal
          open
          onClose={() => ops.setPermissionsFile(null)}
          title="Change Permissions"
          maxWidth="max-w-sm"
        >
          <PermissionsDialog
            file={ops.permissionsFile}
            onConfirm={ops.confirmPermissions}
            onCancel={() => ops.setPermissionsFile(null)}
          />
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

function PermissionsDialog({
  file,
  onConfirm,
  onCancel,
}: {
  file: FileItem;
  onConfirm: (mode: number) => void;
  onCancel: () => void;
}) {
  const currentMode = Number.parseInt(
    file.permissions?.replace(/[^0-7]/g, "") || "644",
    8,
  );
  const [modeStr, setModeStr] = useState(
    currentMode.toString(8).padStart(3, "0"),
  );

  const parsed = Number.parseInt(modeStr, 8);
  const isValid = !Number.isNaN(parsed) && parsed >= 0 && parsed <= 0o7777;

  const ownerBits = isValid ? (parsed >> 6) & 7 : 0;
  const groupBits = isValid ? (parsed >> 3) & 7 : 0;
  const otherBits = isValid ? parsed & 7 : 0;

  const bitLabel = (bit: number, type: "r" | "w" | "x") => {
    const labels = { r: "Read", w: "Write", x: "Execute" };
    return `${labels[type]} (${bit ? "on" : "off"})`;
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-dark-300 mb-1">
          File: <span className="text-white font-medium">{file.name}</span>
        </p>
      </div>

      <div>
        <label
          htmlFor="perm-octal"
          className="block text-sm text-dark-300 mb-1"
        >
          Octal permissions
        </label>
        <input
          id="perm-octal"
          type="text"
          value={modeStr}
          onChange={(e) => setModeStr(e.target.value)}
          className="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-primary-500"
          maxLength={4}
        />
      </div>

      <div className="grid grid-cols-3 gap-4 text-xs">
        <div>
          <div className="text-dark-400 mb-1">
            Owner ({isValid ? ownerBits : "-"})
          </div>
          <div className="space-y-0.5">
            <div className={ownerBits & 4 ? "text-green-400" : "text-dark-500"}>
              {bitLabel(ownerBits & 4, "r")}
            </div>
            <div
              className={ownerBits & 2 ? "text-yellow-400" : "text-dark-500"}
            >
              {bitLabel(ownerBits & 2, "w")}
            </div>
            <div className={ownerBits & 1 ? "text-red-400" : "text-dark-500"}>
              {bitLabel(ownerBits & 1, "x")}
            </div>
          </div>
        </div>
        <div>
          <div className="text-dark-400 mb-1">
            Group ({isValid ? groupBits : "-"})
          </div>
          <div className="space-y-0.5">
            <div className={groupBits & 4 ? "text-green-400" : "text-dark-500"}>
              {bitLabel(groupBits & 4, "r")}
            </div>
            <div
              className={groupBits & 2 ? "text-yellow-400" : "text-dark-500"}
            >
              {bitLabel(groupBits & 2, "w")}
            </div>
            <div className={groupBits & 1 ? "text-red-400" : "text-dark-500"}>
              {bitLabel(groupBits & 1, "x")}
            </div>
          </div>
        </div>
        <div>
          <div className="text-dark-400 mb-1">
            Other ({isValid ? otherBits : "-"})
          </div>
          <div className="space-y-0.5">
            <div className={otherBits & 4 ? "text-green-400" : "text-dark-500"}>
              {bitLabel(otherBits & 4, "r")}
            </div>
            <div
              className={otherBits & 2 ? "text-yellow-400" : "text-dark-500"}
            >
              {bitLabel(otherBits & 2, "w")}
            </div>
            <div className={otherBits & 1 ? "text-red-400" : "text-dark-500"}>
              {bitLabel(otherBits & 1, "x")}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!isValid}
          onClick={() => isValid && onConfirm(parsed)}
        >
          Apply
        </Button>
      </div>
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
            const blob = new Blob([data]);
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
