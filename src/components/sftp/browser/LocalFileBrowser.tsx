import { useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { FolderIcon } from "@phosphor-icons/react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DragOverOverlay,
  DropTargetOverlay,
  ErrorBar,
} from "@/components/sftp/browser/FileBrowserOverlays";
import PasteConflictDialog from "@/components/sftp/browser/PasteConflictDialog";
import { buildBaseContextMenuItems } from "@/components/sftp/browser/shared/buildBaseContextMenuItems";
import FileBrowserListShared from "@/components/sftp/browser/shared/FileBrowserList";
import FileBrowserStatusBar from "@/components/sftp/browser/shared/FileBrowserStatusBar";
import FileBrowserToolbar from "@/components/sftp/browser/shared/FileBrowserToolbar";
import FileGridItem from "@/components/sftp/browser/shared/FileGridItem";
import FileListItem from "@/components/sftp/browser/shared/FileListItem";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import ContextMenu, { type ContextMenuItem } from "@/components/ui/ContextMenu";
import PromptDialog from "@/components/ui/PromptDialog";
import { useClipboard } from "@/hooks/sftp/useClipboard";
import { useFileKeyboardShortcuts } from "@/hooks/sftp/useFileKeyboardShortcuts";
import { useFileOperations } from "@/hooks/sftp/useLocalFileOperations";
import { useMarqueeSelection } from "@/hooks/sftp/useMarqueeSelection";
import {
  type ColumnDef,
  useResizableColumns,
} from "@/hooks/sftp/useResizableColumns";
import { useSortedFiles } from "@/hooks/sftp/useSortedFiles";
import { useTauriDragDrop } from "@/hooks/sftp/useTauriDragDrop";
import { extractError } from "@/lib/common/extractError";
import { isTauriAvailable } from "@/lib/common/utils";
import {
  type FileProvider,
  joinPath,
  LocalFileProvider,
  transferFiles,
} from "@/lib/sftp/fileTransfer";
import { isSameVolume, listLocalFiles } from "@/lib/sftp/localFs";
import { RemoteFileProviderImpl } from "@/lib/sftp/remoteFs";
import {
  fileBrowserActions,
  useFileBrowserStore,
} from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface LocalFileBrowserProps {
  paneId: string;
  rootPath: string;
  onOpenInEditor?: (file: FileItem | null) => void;
}

const localProvider = new LocalFileProvider("local");

const LOCAL_COLUMNS: ColumnDef[] = [
  { key: "type", label: "", defaultWidth: 36, minWidth: 36 },
  { key: "name", label: "Name", defaultWidth: 400, minWidth: 120 },
  { key: "size", label: "Size", defaultWidth: 80, minWidth: 60 },
  { key: "modifiedAt", label: "Modified", defaultWidth: 140, minWidth: 80 },
  { key: "accessedAt", label: "Accessed", defaultWidth: 140, minWidth: 80 },
];

export default function LocalFileBrowser({
  paneId,
  rootPath,
  onOpenInEditor,
}: LocalFileBrowserProps) {
  // ── Store ────────────────────────────────────────────────────────────────
  const paneState = useFileBrowserStore((s) => s.panes[paneId]);
  const activePaneId = useSftpStore((s) => s.activePaneId);
  const getOrCreatePane = useFileBrowserStore((s) => s.getOrCreatePane);

  // Initialize pane on first render
  const initialized = useRef(false);
  if (!initialized.current) {
    // Reset to the root only when the connection identity changed (fresh
    // connect or a different local root). A plain remount after a module
    // switch must keep the current path, files, and history.
    const existing = useFileBrowserStore.getState().panes[paneId];
    const connKey = `local:${rootPath}`;
    if (existing) {
      if (existing.connectionKey !== connKey) {
        fileBrowserActions.resetPane(paneId, rootPath);
        useFileBrowserStore
          .getState()
          .updatePane(paneId, { connectionKey: connKey });
      }
    } else {
      getOrCreatePane(paneId, rootPath);
      useFileBrowserStore
        .getState()
        .updatePane(paneId, { connectionKey: connKey });
    }
    initialized.current = true;
  }

  const files = paneState?.files ?? [];
  const currentPath = paneState?.currentPath ?? rootPath;
  const isLoading = paneState?.isLoading ?? false;
  const error = paneState?.error ?? null;
  const selectedFiles = paneState?.selectedFiles ?? new Set<string>();
  const viewMode = paneState?.viewMode ?? "list";
  const showHidden = paneState?.showHidden ?? false;
  const sortField = paneState?.sortField ?? "name";
  const sortDirection = paneState?.sortDirection ?? "asc";
  const searchQuery = paneState?.searchQuery ?? "";
  const history = paneState?.history ?? [rootPath];
  const historyIndex = paneState?.historyIndex ?? 0;
  const pasteConflicts = paneState?.pasteConflicts ?? null;
  const pendingDrop = paneState?.pendingDrop ?? null;

  const fileDragState = useSftpStore((s) => s.fileDragState);
  const pendingFileDrop = useSftpStore((s) => s.pendingFileDrop);
  const setPendingFileDrop = useSftpStore((s) => s.setPendingFileDrop);
  const activeTransfers = useSftpStore(
    (s) =>
      s.transfers.filter((t) => t.status === "pending" || t.status === "active")
        .length,
  );
  const scanning = useSftpStore((s) => s.transferScanning);

  const actions = fileBrowserActions;

  const { widths: columnWidths, handleMouseDown } = useResizableColumns(
    LOCAL_COLUMNS,
    "local",
  );

  // ── Component-only state ─────────────────────────────────────────────────
  const [pathInput, setPathInput] = useState(currentPath);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file?: FileItem;
  } | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [dropMode, setDropMode] = useState<"move" | "copy">("move");
  const lastVolumeCheck = useRef<{
    src: string;
    dest: string;
    result: boolean;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Transfer execution ───────────────────────────────────────────────────
  const executeTransfer = useCallback(
    async (
      dragFiles: FileItem[],
      destDirPath: string,
      mode: "move" | "copy",
      overrides?: Map<
        string,
        { action: "replace" | "rename" | "auto" | "skip"; newName?: string }
      >,
      sourceProvider?: FileProvider,
    ) => {
      const src = sourceProvider ?? localProvider;

      await transferFiles({
        source: src,
        dest: localProvider,
        files: dragFiles,
        destPath: destDirPath,
        mode: sourceProvider ? "copy" : mode,
        sessionId: paneId,
        overrides,
      });

      try {
        const fresh = await listLocalFiles(currentPath);
        actions.setFiles(paneId, fresh);
      } catch {
        // silent fail
      }

      if (mode === "move") {
        const sourceDir =
          dragFiles[0]?.path.split(/[/\\]/).slice(0, -1).join("/") || "";
        if (sourceDir) {
          const allPanes = useFileBrowserStore.getState().panes;
          for (const [id, p] of Object.entries(allPanes)) {
            if (id === paneId) continue;
            const paneDir = p.currentPath.replace(/\\/g, "/");
            if (paneDir === sourceDir.replace(/\\/g, "/")) {
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
    },
    [currentPath, paneId],
  );

  // ── Extracted hooks ──────────────────────────────────────────────────────
  const fileOps = useFileOperations({ paneId, currentPath, files });
  const clipboard = useClipboard({ paneId, currentPath, files, selectedFiles });
  const marquee = useMarqueeSelection({
    paneId,
    containerRef,
    selectedFiles,
    onClearSelection: useCallback(
      () => actions.clearSelection(paneId),
      [paneId],
    ),
  });

  // ── Tauri OS drag-drop (reliable cross-platform file drops) ─────────────
  const handleTauriDrop = useCallback(
    async (paths: string[], destDir: string) => {
      const { invoke } = await import("@tauri-apps/api/core");

      const dropFiles: FileItem[] = [];
      for (const p of paths) {
        const name = p.split(/[/\\]/).pop() || p;
        const isDir = await invoke<boolean>("is_directory", { path: p }).catch(
          () => false,
        );
        const size = isDir
          ? 0
          : await invoke<number>("get_file_size", { path: p }).catch(() => 0);
        dropFiles.push({
          name,
          path: p,
          type: isDir ? "directory" : "file",
          size,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date().toISOString(),
          accessedAt: new Date().toISOString(),
          isHidden: name.startsWith("."),
        });
      }

      let destFiles: FileItem[];
      try {
        destFiles = await listLocalFiles(destDir);
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
            dstPath: joinPath(destDir, f.name),
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

      await executeTransfer(dropFiles, destDir, "copy");
    },
    [paneId, executeTransfer],
  );

  const tauriDragDrop = useTauriDragDrop({
    paneId,
    currentPath,
    hostId: "local",
    onDrop: handleTauriDrop,
  });

  // ── Effects ──────────────────────────────────────────────────────────────
  // Skip the loading flash on fresh mount when the pane already has files
  // for this path (module-switch remount). Only show loading when the user
  // actually navigates to a new directory.
  const mountInitRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only guard — intentionally reads snapshot once
  useEffect(() => {
    if (mountInitRef.current) {
      mountInitRef.current = false;
      if (
        paneState &&
        paneState.currentPath === currentPath &&
        paneState.files.length > 0
      ) {
        setPathInput(currentPath);
        return;
      }
    }
    actions.loadFiles(paneId, currentPath, listLocalFiles);
    setPathInput(currentPath);
  }, [currentPath, paneId]);

  // Navigate to the root only when rootPath changes while the component
  // stays mounted (e.g. user reconnects the pane to a different folder).
  // On fresh mount (including remount after module switch) the init block
  // and loadFiles effect already handle the correct currentPath — we must
  // NOT force-navigate to root here.
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRootRef.current === null) {
      // First render after mount — record rootPath but don't navigate.
      prevRootRef.current = rootPath;
      return;
    }
    if (prevRootRef.current !== rootPath) {
      prevRootRef.current = rootPath;
      actions.navigateTo(paneId, rootPath, true);
      setPathInput(rootPath);
    }
  }, [rootPath, paneId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref focus effect
  useEffect(() => {
    if (fileOps.renamingPath && fileOps.renameInputRef.current) {
      fileOps.renameInputRef.current.focus();
      fileOps.renameInputRef.current.select();
    }
  }, [fileOps.renamingPath]);

  // ── Navigation ───────────────────────────────────────────────────────────
  const navigateTo = useCallback(
    (path: string, skipHistory = false) => {
      actions.navigateTo(paneId, path, skipHistory);
      setPathInput(path);
    },
    [paneId],
  );

  const navigateBack = useCallback(
    () => actions.navigateBack(paneId),
    [paneId],
  );

  const navigateForward = useCallback(
    () => actions.navigateForward(paneId),
    [paneId],
  );

  const navigateUp = useCallback(() => actions.navigateUp(paneId), [paneId]);

  const handleDoubleClick = useCallback(
    (file: FileItem) => {
      if (file.type === "directory") navigateTo(file.path);
    },
    [navigateTo],
  );

  // ── Recompute sorted files during render (no stale effect lag) ──────────
  const computedSortedFiles = useSortedFiles({
    files,
    showHidden,
    searchQuery,
    sortField,
    sortDirection,
  });

  // Sync computed value back to store for remote browser reusability
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — store sync only
  useEffect(() => {
    actions.updateSortedFiles(paneId);
  }, [computedSortedFiles]);

  const handleSelect = useCallback(
    (fileName: string, isMultiSelect: boolean, isRangeSelect: boolean) => {
      actions.selectFile(
        paneId,
        fileName,
        isMultiSelect,
        isRangeSelect,
        computedSortedFiles,
      );
    },
    [paneId, computedSortedFiles],
  );

  // ── Handle pending file drops from SftpLayout ────────────────────────────
  useEffect(() => {
    if (!pendingFileDrop) return;
    if (pendingFileDrop.destPaneId !== paneId) return;

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

    const isSamePane = sourcePaneId === paneId;
    const sep = destDirPath.includes("\\") ? "\\" : "/";
    const isSameDir =
      dragFiles[0]?.path.split(/[/\\]/).slice(0, -1).join(sep) === destDirPath;

    if (isSamePane && isSameDir) {
      setPendingFileDrop(null);
      return;
    }

    (async () => {
      let mode: "move" | "copy";
      try {
        const same = await isSameVolume(
          dragFiles[0]?.path ?? destDirPath,
          destDirPath,
        );
        mode = same ? "move" : "copy";
      } catch {
        mode = isSamePane ? "move" : "copy";
      }

      const isCrossProviderRemote = sourceHostId && sourceHostId !== "local";
      const sourceProvider = isCrossProviderRemote
        ? new RemoteFileProviderImpl(sourceHostId, sourcePaneId ?? sourceHostId)
        : undefined;

      let destFiles: FileItem[];
      try {
        destFiles = await listLocalFiles(destDirPath);
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
            dstPath: `${destDirPath}/${f.name}`,
            dstName: f.name,
          })),
        );
        actions.setPendingDrop(paneId, {
          files: dragFiles,
          destDirPath,
          mode,
          sourceHostId,
          sourcePaneId,
        });
      } else {
        await executeTransfer(
          dragFiles,
          destDirPath,
          mode,
          undefined,
          sourceProvider,
        );
      }
    })();

    setPendingFileDrop(null);
  }, [pendingFileDrop, paneId, executeTransfer, setPendingFileDrop]);

  const handleConflictConfirm = useCallback(
    async (
      overrides: Map<
        string,
        { action: "replace" | "rename" | "auto" | "skip"; newName?: string }
      >,
    ) => {
      if (!pendingDrop) return;
      const {
        files: dragFiles,
        destDirPath,
        mode,
        sourceHostId,
        sourcePaneId,
        sourceKind,
      } = pendingDrop;
      actions.setPasteConflicts(paneId, null);
      actions.setPendingDrop(paneId, null);
      const isCrossProviderRemote = sourceHostId && sourceHostId !== "local";
      const sourceProvider = isCrossProviderRemote
        ? new RemoteFileProviderImpl(sourceHostId, sourcePaneId ?? sourceHostId)
        : undefined;
      await executeTransfer(
        dragFiles,
        destDirPath,
        mode,
        overrides,
        sourceProvider,
      );
      if (sourceKind === "clipboard") {
        useSftpStore.getState().clearClipboard();
      }
    },
    [pendingDrop, executeTransfer, paneId],
  );

  const handleConflictCancel = useCallback(() => {
    actions.setPasteConflicts(paneId, null);
    actions.setPendingDrop(paneId, null);
    if (
      pendingDrop?.sourceKind === "clipboard" &&
      useSftpStore.getState().clipboardMode === "cut"
    ) {
      useSftpStore.getState().clearClipboard();
    }
  }, [paneId, pendingDrop]);

  // ── @dnd-kit droppable ───────────────────────────────────────────────────
  const droppable = useDroppable({
    id: `file-drop-${paneId}`,
    data: { type: "file-drop", paneId, hostId: "local", path: currentPath },
  });

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      droppable.ref(node);
    },
    [droppable.ref],
  );

  // ── @dnd-kit drag monitor ────────────────────────────────────────────────
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
        const normalize = (p: string) => p.replace(/\\/g, "/");
        const srcDir =
          normalize(dragFiles[0]?.path ?? "")
            .split("/")
            .slice(0, -1)
            .join("/") || "/";
        const isNoop =
          sourceHostId === destHostId &&
          normalize(srcDir) === normalize(destDirPath);
        const shouldShow =
          !isNoop &&
          destDirPath === currentPath &&
          target.data.paneId === paneId;
        setIsDropTarget(shouldShow);

        if (shouldShow) {
          if (sourceHostId !== "local" || destHostId !== "local") {
            setDropMode("copy");
          } else {
            const srcPath = dragFiles[0]?.path ?? "";
            const cached = lastVolumeCheck.current;
            if (
              cached &&
              cached.src === srcPath &&
              cached.dest === destDirPath
            ) {
              setDropMode(cached.result ? "move" : "copy");
            } else {
              isSameVolume(srcPath || destDirPath, destDirPath)
                .then((same) => {
                  lastVolumeCheck.current = {
                    src: srcPath,
                    dest: destDirPath,
                    result: same,
                  };
                  setDropMode(same ? "move" : "copy");
                })
                .catch(() => setDropMode("copy"));
            }
          }
        }
      } else {
        setIsDropTarget(false);
      }
    },
    onDragEnd() {
      setIsDropTarget(false);
    },
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(
    () => actions.loadFiles(paneId, currentPath, listLocalFiles),
    [currentPath, paneId],
  );

  useFileKeyboardShortcuts({
    selectedFiles,
    files,
    onRename: fileOps.startRename,
    onNavigateUp: navigateUp,
    onRefresh: handleRefresh,
    onClearSelection: useCallback(
      () => actions.clearSelection(paneId),
      [paneId],
    ),
    onCopy: clipboard.handleCopy,
    onCut: clipboard.handleCut,
    onPaste: clipboard.handlePaste,
    onDelete: fileOps.handleDeleteSelected,
    onNewFile: fileOps.handleNewFile,
    onNewFolder: fileOps.handleNewFolder,
    activePaneId,
    paneId,
  });

  // ── Context menu items ───────────────────────────────────────────────────
  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? contextMenu.file
      ? buildBaseContextMenuItems({
          menuFile: contextMenu.file,
          selectedFiles,
          hasClipboard: !!useSftpStore.getState().clipboard,
          actions: {
            onCopy: clipboard.handleCopy,
            onCut: clipboard.handleCut,
            onPaste: clipboard.handlePaste,
            onDelete: fileOps.handleDelete,
            onDeleteSelected: fileOps.handleDeleteSelected,
            onNewFile: fileOps.handleNewFile,
            onNewFolder: fileOps.handleNewFolder,
          },
          onRename: fileOps.startRename,
          beforeItems: [
            {
              label: "Open",
              onClick: async () => {
                if (!contextMenu.file) return;
                try {
                  await openPath(contextMenu.file.path);
                } catch (err) {
                  toast.error(extractError(err, "Failed to open file"));
                }
              },
            },
            ...(onOpenInEditor
              ? [
                  {
                    label: "Open in Editor",
                    onClick: () => onOpenInEditor(contextMenu.file ?? null),
                  },
                ]
              : []),
            {
              label: "Show in Explorer",
              onClick: async () => {
                if (!contextMenu.file) return;
                try {
                  await revealItemInDir(contextMenu.file.path);
                } catch (err) {
                  toast.error(
                    extractError(err, "Failed to reveal in Explorer"),
                  );
                }
              },
            },
          ],
        })
      : buildBaseContextMenuItems({
          menuFile: null,
          hasClipboard: !!useSftpStore.getState().clipboard,
          actions: {
            onCopy: clipboard.handleCopy,
            onCut: clipboard.handleCut,
            onPaste: clipboard.handlePaste,
            onDelete: fileOps.handleDelete,
            onNewFile: fileOps.handleNewFile,
            onNewFolder: fileOps.handleNewFolder,
          },
          onRename: fileOps.startRename,
          afterItems: [
            ...(onOpenInEditor
              ? [
                  {
                    label: "Open in Editor",
                    onClick: () => onOpenInEditor(null),
                  },
                ]
              : []),
            { type: "separator" as const },
            {
              label: "Refresh",
              shortcut: "F5",
              onClick: handleRefresh,
            },
          ],
        })
    : [];

  // ── Context menu handlers ────────────────────────────────────────────────
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: FileItem) => {
      e.preventDefault();
      e.stopPropagation();
      useSftpStore.getState().setActivePane(paneId);
      if (!selectedFiles.has(file.name)) {
        useFileBrowserStore.getState().updatePane(paneId, {
          selectedFiles: new Set([file.name]),
        });
      }
      setContextMenu({ x: e.clientX, y: e.clientY, file });
    },
    [paneId, selectedFiles],
  );

  const handleBackgroundContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      useSftpStore.getState().setActivePane(paneId);
      actions.clearSelection(paneId);
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [paneId],
  );

  // ── Desktop drag-and-drop (native OS, via Tauri paths) ───────────────────
  // No DOM handlers: OS drops arrive as real paths via useTauriDragDrop,
  // which supports files AND folders (transferFiles handles recursion).

  // ── Path bar ─────────────────────────────────────────────────────────────
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") navigateTo(pathInput);
    else if (e.key === "Escape") setPathInput(currentPath);
  };

  // ── Guard: Tauri only ───────────────────────────────────────────────────
  if (!isTauriAvailable()) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-dark-900 text-center px-6">
        <FolderIcon className="w-16 h-16 mb-4 text-dark-600" weight="bold" />
        <p className="text-dark-300 text-sm mb-1">
          Local filesystem is only available in the desktop app
        </p>
        <p className="text-dark-500 text-xs">
          Run{" "}
          <code className="bg-dark-800 px-1.5 py-0.5 rounded">
            npm run tauri dev
          </code>{" "}
          to test locally
        </p>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file browser container needs mousedown for marquee + drag-drop
    <div
      ref={setContainerRef}
      className="h-full flex flex-col bg-dark-900 relative select-none"
      data-drop-target-path={currentPath}
      data-drop-target-pane={paneId}
      data-drop-target-host="local"
      onContextMenu={handleBackgroundContextMenu}
      onMouseDown={(e) => {
        actions.setActivePane(paneId);
        marquee.handleMouseDown(e);
      }}
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
        hostId="local"
        dropMode={dropMode}
      />

      <FileBrowserToolbar
        currentPath={currentPath}
        pathLabel="Local path"
        searchQuery={searchQuery}
        showHidden={showHidden}
        viewMode={viewMode}
        pathInput={pathInput}
        onPathInputChange={setPathInput}
        onPathInputKeyDown={handlePathKeyDown}
        onPathInputBlur={() => setPathInput(currentPath)}
        onNavigateTo={() => {}}
        onNavigateRoot={() => navigateTo(rootPath)}
        onNavigateBack={navigateBack}
        onNavigateForward={navigateForward}
        canNavigateBack={historyIndex > 0}
        canNavigateForward={historyIndex < history.length - 1}
        onNavigateUp={navigateUp}
        onRefresh={() => actions.loadFiles(paneId, currentPath, listLocalFiles)}
        onNewFolder={fileOps.handleNewFolder}
        onSearchChange={(q) => actions.setSearchQuery(paneId, q)}
        onShowHiddenChange={(s) => actions.setShowHidden(paneId, s)}
        onViewModeChange={(m) => actions.setViewMode(paneId, m)}
        showBackForward
        onDisconnect={() => {
          actions.resetPane(paneId, rootPath);
          useSftpStore.getState().disconnectPane(paneId);
        }}
      />

      <ErrorBar error={error} setError={() => actions.clearError(paneId)} />

      {isLoading && (
        <div className="flex-1 p-3 space-y-1">
          {Array.from({ length: 8 }, (_, i) => `sk-${i}`).map((key) => (
            <div
              key={key}
              className="flex items-center gap-3 p-2 animate-pulse"
            >
              <div className="w-5 h-5 bg-dark-700 rounded" />
              <div
                className="h-3 bg-dark-700 rounded flex-1"
                style={{ width: `${40 + Math.random() * 40}%` }}
              />
            </div>
          ))}
        </div>
      )}

      {!isLoading && computedSortedFiles.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-dark-400">
          <FolderIcon className="w-16 h-16 mb-3 text-dark-600" weight="bold" />
          <p>{searchQuery ? "No matching files" : "Empty directory"}</p>
        </div>
      )}

      {!isLoading && computedSortedFiles.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          <FileBrowserListShared
            files={computedSortedFiles}
            viewMode={viewMode}
            columns={LOCAL_COLUMNS}
            columnWidths={columnWidths}
            handleColumnMouseDown={handleMouseDown}
            sortField={sortField}
            sortDirection={sortDirection}
            setSortField={(f) => actions.setSortField(paneId, f)}
            setSortDirection={(fn) => {
              const next = typeof fn === "function" ? fn(sortDirection) : fn;
              useFileBrowserStore.getState().updatePane(paneId, {
                sortDirection: next,
              });
            }}
            renderListItem={(file) => (
              <FileListItem
                key={file.path}
                file={file}
                paneId={paneId}
                hostId="local"
                selectedFiles={selectedFiles}
                allFiles={computedSortedFiles}
                renamingPath={fileOps.renamingPath}
                renameValue={fileOps.renameValue}
                renameInputRef={fileOps.renameInputRef}
                columnWidths={columnWidths}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
                onRenameValueChange={(v) => actions.setRenameValue(paneId, v)}
                onCommitRename={fileOps.commitRename}
                onSetRenamingPath={(p) => actions.setRenamingPath(paneId, p)}
              />
            )}
            renderGridItem={(file) => (
              <FileGridItem
                key={file.path}
                file={file}
                paneId={paneId}
                hostId="local"
                selectedFiles={selectedFiles}
                allFiles={computedSortedFiles}
                renamingPath={fileOps.renamingPath}
                renameValue={fileOps.renameValue}
                renameInputRef={fileOps.renameInputRef}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
                onRenameValueChange={(v) => actions.setRenameValue(paneId, v)}
                onCommitRename={fileOps.commitRename}
                onSetRenamingPath={(p) => actions.setRenamingPath(paneId, p)}
              />
            )}
          />
        </div>
      )}

      <FileBrowserStatusBar
        totalCount={computedSortedFiles.length}
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

      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pasteConflicts && (
        <PasteConflictDialog
          conflicts={pasteConflicts}
          onConfirm={handleConflictConfirm}
          onCancel={handleConflictCancel}
        />
      )}

      {fileOps.newFileModal.open && (
        <PromptDialog
          open={fileOps.newFileModal.open}
          title="New File"
          placeholder="filename.txt"
          confirmLabel="Create"
          onConfirm={fileOps.confirmNewFile}
          onClose={fileOps.newFileModal.hide}
        />
      )}

      {fileOps.newFolderModal.open && (
        <PromptDialog
          open={fileOps.newFolderModal.open}
          title="New Folder"
          placeholder="folder name"
          confirmLabel="Create"
          onConfirm={fileOps.confirmNewFolder}
          onClose={fileOps.newFolderModal.hide}
        />
      )}

      <ConfirmDeleteDialog
        open={fileOps.deleteDialogOpen}
        message={fileOps.deleteMessage}
        onConfirm={fileOps.confirmDelete}
        onCancel={fileOps.cancelDelete}
      />
    </div>
  );
}
