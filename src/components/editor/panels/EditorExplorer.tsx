import { useDraggable } from "@dnd-kit/react";
import {
  ArrowClockwiseIcon,
  CaretLineUpIcon,
  CaretRightIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
} from "@phosphor-icons/react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { buildExplorerMenuItems } from "@/components/editor/panels/explorerMenu";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import ContextMenu, { type ContextMenuItem } from "@/components/ui/ContextMenu";
import PromptDialog from "@/components/ui/PromptDialog";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { extractError } from "@/lib/common/extractError";
import { isTauriAvailable } from "@/lib/common/utils";
import { getEditorProvider } from "@/lib/editor/editorProvider";
import { getFileIcon } from "@/lib/sftp/fileHelpers";
import {
  type EditorDirState,
  useActiveViewId,
  useEditorStore,
} from "@/stores/editor/editorStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface EditorExplorerProps {
  rootPath: string;
}

interface RenameState {
  path: string;
  name: string;
}

interface Api {
  dirs: Record<string, EditorDirState>;
  selectedPath: string | null;
  activePath: string | null;
  renaming: RenameState | null;
  onRowClick: (file: FileItem) => void;
  onRowDoubleClick: (file: FileItem) => void;
  onRowMenu: (e: React.MouseEvent, file: FileItem) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRefreshDir: (path: string) => void;
  onStartRename: (file: FileItem) => void;
  onCommitRename: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
}

function dirName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith("/") || parent.endsWith("\\")
    ? `${parent}${name}`
    : `${parent}/${name}`;
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  const commit = () => {
    const name = value.trim();
    if (name && name !== initial) onCommit(name);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={commit}
      className="flex-1 min-w-0 bg-dark-950 border border-primary-500 text-white text-xs px-1 py-0.5 rounded outline-none"
    />
  );
}

function Branch({
  file,
  depth,
  api,
}: {
  file: FileItem;
  depth: number;
  api: Api;
}) {
  const isDir = file.type === "directory";
  const dir = isDir ? api.dirs[file.path] : null;
  const expanded = dir?.expanded ?? false;
  const loading = isDir && dir?.children === null;
  const error = isDir ? (dir?.error ?? null) : null;
  const isSelected = api.selectedPath === file.path;
  const isRenaming = api.renaming?.path === file.path;
  const children = dir?.children ?? [];
  const indent = 8 + depth * 12;

  const draggable = useDraggable({
    id: `editor-file-${file.path}`,
    data: {
      type: "editor-file-source",
      path: file.path,
      name: file.name,
      kind: file.type,
    },
  });

  return (
    <>
      <div
        ref={draggable.ref}
        role="treeitem"
        tabIndex={-1}
        aria-expanded={isDir ? expanded : undefined}
        className={`group flex items-center gap-1 h-6 pr-1 cursor-pointer select-none ${
          isSelected ? "bg-dark-700/70 text-white" : "hover:bg-dark-700/40"
        } ${draggable.isDragging ? "opacity-40" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={() => api.onRowClick(file)}
        onDoubleClick={() => api.onRowDoubleClick(file)}
        onKeyDown={accessibleClickHandler(() => api.onRowClick(file))}
        onContextMenu={(e) => api.onRowMenu(e, file)}
      >
        {isDir ? (
          <CaretRightIcon
            className={`w-3.5 h-3.5 shrink-0 text-dark-400 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            weight="bold"
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {getFileIcon(file, 16, isDir && expanded)}

        {isRenaming ? (
          <RenameInput
            initial={file.name}
            onCommit={(name) => api.onCommitRename(file.path, name)}
            onCancel={api.onCancelRename}
          />
        ) : (
          <span
            className={`truncate ${
              isDir || isSelected ? "text-white" : "text-dark-300"
            }`}
            title={file.path}
          >
            {file.name}
          </span>
        )}

        {isDir && !isRenaming && (
          <span className="ml-auto hidden group-hover:flex items-center gap-0.5 pr-0.5">
            <button
              type="button"
              title="New File"
              className="p-0.5 rounded text-dark-400 hover:text-white hover:bg-dark-600"
              onClick={(e) => {
                e.stopPropagation();
                api.onNewFile(file.path);
              }}
            >
              <FilePlusIcon className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="New Folder"
              className="p-0.5 rounded text-dark-400 hover:text-white hover:bg-dark-600"
              onClick={(e) => {
                e.stopPropagation();
                api.onNewFolder(file.path);
              }}
            >
              <FolderPlusIcon className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="Refresh"
              className="p-0.5 rounded text-dark-400 hover:text-white hover:bg-dark-600"
              onClick={(e) => {
                e.stopPropagation();
                api.onRefreshDir(file.path);
              }}
            >
              <ArrowClockwiseIcon className="w-3.5 h-3.5" />
            </button>
          </span>
        )}
      </div>

      {isDir && expanded && (
        <div>
          {loading ? (
            <div
              className="flex items-center gap-2 h-6 text-xs text-dark-500"
              style={{ paddingLeft: indent + 12 }}
            >
              <span className="w-3 h-3 border border-dark-500 border-t-transparent rounded-full animate-spin" />
              Loading...
            </div>
          ) : error ? (
            <div
              className="flex items-center gap-2 h-6 text-xs text-red-400"
              style={{ paddingLeft: indent + 12 }}
            >
              <span className="truncate max-w-40">{error}</span>
              <button
                type="button"
                className="text-primary-400 hover:underline shrink-0"
                onClick={() => api.onRefreshDir(file.path)}
              >
                Retry
              </button>
            </div>
          ) : (
            children.map((c) => (
              <Branch key={c.path} file={c} depth={depth + 1} api={api} />
            ))
          )}
        </div>
      )}
    </>
  );
}

export default function EditorExplorer({ rootPath }: EditorExplorerProps) {
  const openFile = useEditorStore((s) => s.openFile);
  const activeViewId = useActiveViewId();
  const activePath = useEditorStore((s) => s.activeFile[activeViewId]) ?? null;

  const dirs = useEditorStore((s) => s.explorerDirs);
  const selectedPath = useEditorStore((s) => s.explorerSelectedPath);
  const explorerRootPath = useEditorStore((s) => s.explorerRootPath);
  const setExplorerDir = useEditorStore((s) => s.setExplorerDir);
  const setExplorerDirs = useEditorStore((s) => s.setExplorerDirs);
  const setExplorerSelectedPath = useEditorStore(
    (s) => s.setExplorerSelectedPath,
  );
  const setExplorerRootPath = useEditorStore((s) => s.setExplorerRootPath);
  const connectionType = useEditorStore((s) => s.connectionType);
  const isRemote = connectionType === "host";

  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: FileItem | null;
  } | null>(null);
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const patchDir = useCallback(
    (path: string, patch: Partial<EditorDirState>) => {
      setExplorerDir(path, patch);
    },
    [setExplorerDir],
  );

  const loadDir = useCallback(
    async (path: string) => {
      patchDir(path, { children: null, error: null });
      try {
        const provider = getEditorProvider(useEditorStore.getState());
        const items = await provider.listFiles(path);
        const sorted = [...items].sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
          }
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        });
        patchDir(path, { children: sorted, error: null });
      } catch (err) {
        const message = extractError(err, "Failed to read directory");
        patchDir(path, { children: [], error: message });
      }
    },
    [patchDir],
  );

  const resetTree = useCallback(() => {
    setExplorerDirs({});
    setExplorerSelectedPath(null);
    setRenaming(null);
    setMenu(null);
    setDeletePath(null);
  }, [setExplorerDirs, setExplorerSelectedPath]);

  // Initialize root when the pane connects (kept in store so the tree
  // survives unmount when navigating between modules)
  useEffect(() => {
    if (explorerRootPath === rootPath && dirs[rootPath] !== undefined) return;
    resetTree();
    patchDir(rootPath, { children: null, expanded: true, error: null });
    loadDir(rootPath);
    setExplorerRootPath(rootPath);
  }, [
    rootPath,
    explorerRootPath,
    dirs,
    resetTree,
    patchDir,
    loadDir,
    setExplorerRootPath,
  ]);

  // Keep selection in sync with the active editor file
  useEffect(() => {
    if (activePath) setExplorerSelectedPath(activePath);
  }, [activePath, setExplorerSelectedPath]);

  const rootFile = useMemo<FileItem>(
    () => ({
      name: dirName(rootPath) || rootPath,
      path: rootPath,
      type: "directory",
      size: 0,
      permissions: "",
      owner: "",
      group: "",
      modifiedAt: "",
      isHidden: false,
    }),
    [rootPath],
  );

  const findItem = useCallback(
    (path: string): FileItem | null => {
      if (path === rootPath) return rootFile;
      for (const dir of Object.values(dirs)) {
        for (const item of dir.children ?? []) {
          if (item.path === path) return item;
        }
      }
      return null;
    },
    [rootPath, dirs, rootFile],
  );

  const toggleDir = useCallback(
    (path: string) => {
      const dir = dirs[path];
      const nextExpanded = !(dir?.expanded ?? false);
      patchDir(path, { expanded: nextExpanded });
      if (nextExpanded && !dir?.children) loadDir(path);
    },
    [dirs, patchDir, loadDir],
  );

  const refreshDir = useCallback(
    (path: string) => {
      patchDir(path, { expanded: true });
      loadDir(path);
    },
    [patchDir, loadDir],
  );

  const collapseAll = useCallback(() => {
    const next: Record<string, EditorDirState> = {};
    for (const [path, dir] of Object.entries(dirs)) {
      next[path] = { ...dir, expanded: false };
    }
    if (next[rootPath]) next[rootPath].expanded = true;
    setExplorerDirs(next);
  }, [dirs, rootPath, setExplorerDirs]);

  const handleRowClick = useCallback(
    (file: FileItem) => {
      treeRef.current?.focus();
      setExplorerSelectedPath(file.path);
      if (file.type === "directory") {
        toggleDir(file.path);
        return;
      }
      openFile(file.path, file.name, true);
    },
    [openFile, toggleDir, setExplorerSelectedPath],
  );

  const handleRowDoubleClick = useCallback(
    (file: FileItem) => {
      if (file.type === "directory") return;
      openFile(file.path, file.name, false);
    },
    [openFile],
  );

  const handleRowMenu = useCallback(
    (e: React.MouseEvent, file: FileItem) => {
      e.preventDefault();
      e.stopPropagation();
      treeRef.current?.focus();
      setExplorerSelectedPath(file.path);
      setMenu({ x: e.clientX, y: e.clientY, file });
    },
    [setExplorerSelectedPath],
  );

  const handleBackgroundMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setExplorerSelectedPath(null);
      setMenu({ x: e.clientX, y: e.clientY, file: null });
    },
    [setExplorerSelectedPath],
  );

  const startRename = useCallback((file: FileItem) => {
    setRenaming({ path: file.path, name: file.name });
    setMenu(null);
  }, []);

  const commitRename = useCallback(
    async (oldPath: string, newName: string) => {
      const parent = oldPath.slice(
        0,
        Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\")),
      );
      const newPath = joinPath(parent, newName);
      try {
        const provider = getEditorProvider(useEditorStore.getState());
        await provider.moveFile(oldPath, newPath);
        setRenaming(null);
        const wasActive =
          useEditorStore.getState().activeFile[activeViewId] === oldPath;
        useEditorStore.getState().closeFileEverywhere(oldPath);
        if (wasActive) {
          openFile(newPath, newName);
        }
        setExplorerSelectedPath(newPath);
        resetTree();
        patchDir(rootPath, { children: null, expanded: true, error: null });
        loadDir(rootPath);
      } catch (err) {
        toast.error(extractError(err, "Failed to rename"));
        setRenaming(null);
      }
    },
    [
      activeViewId,
      openFile,
      resetTree,
      rootPath,
      loadDir,
      setExplorerSelectedPath,
      patchDir,
    ],
  );

  const confirmNewFile = useCallback(
    async (name: string) => {
      const parent = newFileParent ?? rootPath;
      const path = joinPath(parent, name);
      const existing = Object.values(dirs).flatMap((d) => d.children ?? []);
      if (existing.some((f) => f.path === path)) {
        toast.error("A file or folder with this name already exists");
        return;
      }
      try {
        const provider = getEditorProvider(useEditorStore.getState());
        await provider.writeFile(path, new Uint8Array(0));
        openFile(path, name, false);
        loadDir(parent);
      } catch (err) {
        toast.error(extractError(err, "Failed to create file"));
      }
    },
    [newFileParent, rootPath, dirs, openFile, loadDir],
  );

  const confirmNewFolder = useCallback(
    async (name: string) => {
      const parent = newFolderParent ?? rootPath;
      const path = joinPath(parent, name);
      const existing = Object.values(dirs).flatMap((d) => d.children ?? []);
      if (existing.some((f) => f.path === path)) {
        toast.error("A file or folder with this name already exists");
        return;
      }
      try {
        const provider = getEditorProvider(useEditorStore.getState());
        await provider.mkdir(path);
        loadDir(parent);
      } catch (err) {
        toast.error(extractError(err, "Failed to create folder"));
      }
    },
    [newFolderParent, rootPath, dirs, loadDir],
  );

  const confirmDelete = useCallback(async () => {
    if (!deletePath) return;
    try {
      const provider = getEditorProvider(useEditorStore.getState());
      await provider.removeFile(deletePath);
      useEditorStore.getState().closeFileEverywhere(deletePath);
      if (selectedPath === deletePath) setExplorerSelectedPath(null);
      setDeletePath(null);
      resetTree();
      patchDir(rootPath, { children: null, expanded: true, error: null });
      loadDir(rootPath);
    } catch (err) {
      toast.error(extractError(err, "Failed to delete"));
      setDeletePath(null);
    }
  }, [
    deletePath,
    selectedPath,
    setExplorerSelectedPath,
    resetTree,
    rootPath,
    loadDir,
    patchDir,
  ]);

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success("Path copied to clipboard");
    } catch {
      toast.error("Failed to copy path");
    }
  }, []);

  const revealInExplorer = useCallback(async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (err) {
      toast.error(extractError(err, "Failed to reveal in Explorer"));
    }
  }, []);

  const openInSystem = useCallback(async (path: string) => {
    try {
      await openPath(path);
    } catch (err) {
      toast.error(extractError(err, "Failed to open file"));
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectedPath) return;
      const item = findItem(selectedPath);
      if (!item) return;
      if (e.key === "F2") {
        e.preventDefault();
        startRename(item);
      } else if (e.key === "Delete") {
        e.preventDefault();
        setDeletePath(selectedPath);
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleRowClick(item);
      } else if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        copyPath(selectedPath);
      }
    },
    [selectedPath, findItem, startRename, handleRowClick, copyPath],
  );

  const buildMenuItems = useCallback((): ContextMenuItem[] => {
    const file = menu?.file ?? null;
    const isDir = file?.type === "directory";
    const parent = file
      ? file.path.slice(
          0,
          Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")),
        )
      : rootPath;

    return buildExplorerMenuItems({
      file,
      isDir,
      parent,
      rootPath,
      isRemote,
      handlers: {
        openFile,
        openInSystem,
        setNewFileParent,
        setNewFolderParent,
        startRename,
        setDeletePath,
        revealInExplorer,
        copyPath,
        refreshDir,
      },
    });
  }, [
    menu,
    rootPath,
    isRemote,
    openFile,
    startRename,
    revealInExplorer,
    copyPath,
    openInSystem,
    refreshDir,
  ]);

  const menuItems = useMemo(
    () => (menu ? buildMenuItems() : []),
    [menu, buildMenuItems],
  );

  const api: Api = {
    dirs,
    selectedPath,
    activePath,
    renaming,
    onRowClick: handleRowClick,
    onRowDoubleClick: handleRowDoubleClick,
    onRowMenu: handleRowMenu,
    onNewFile: setNewFileParent,
    onNewFolder: setNewFolderParent,
    onRefreshDir: refreshDir,
    onStartRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: () => setRenaming(null),
  };

  if (!isTauriAvailable()) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-dark-900 border-r border-dark-800 px-4 text-center">
        <FolderIcon className="w-8 h-8 mb-2 text-dark-600" weight="bold" />
        <p className="text-xs text-dark-400">
          Local filesystem requires the desktop app
        </p>
      </div>
    );
  }

  const deleteItem = deletePath ? findItem(deletePath) : null;

  return (
    <div className="w-full h-full flex flex-col bg-dark-900 border-r border-dark-800">
      {/* Section header */}
      <div className="flex items-center justify-between pl-3 pr-1.5 h-8 border-b border-dark-800 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dark-300">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="New File"
            className="p-1 rounded text-dark-500 hover:text-white hover:bg-dark-700"
            onClick={() => setNewFileParent(rootPath)}
          >
            <FilePlusIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="New Folder"
            className="p-1 rounded text-dark-500 hover:text-white hover:bg-dark-700"
            onClick={() => setNewFolderParent(rootPath)}
          >
            <FolderPlusIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Refresh"
            className="p-1 rounded text-dark-500 hover:text-white hover:bg-dark-700"
            onClick={() => refreshDir(rootPath)}
          >
            <ArrowClockwiseIcon className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Collapse All"
            className="p-1 rounded text-dark-500 hover:text-white hover:bg-dark-700"
            onClick={collapseAll}
          >
            <CaretLineUpIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div
        ref={treeRef}
        role="tree"
        tabIndex={0}
        className="flex-1 overflow-y-auto py-1 min-h-0 outline-none text-[13px]"
        onKeyDown={handleKeyDown}
        onContextMenu={handleBackgroundMenu}
      >
        {dirs[rootPath] && <Branch file={rootFile} depth={0} api={api} />}
      </div>

      {/* Dialogs */}
      {newFileParent !== null && (
        <PromptDialog
          open
          title="New File"
          placeholder="filename.txt"
          defaultValue="Untitled-1"
          confirmLabel="Create"
          onConfirm={confirmNewFile}
          onClose={() => setNewFileParent(null)}
        />
      )}

      {newFolderParent !== null && (
        <PromptDialog
          open
          title="New Folder"
          placeholder="folder name"
          defaultValue="New Folder"
          confirmLabel="Create"
          onConfirm={confirmNewFolder}
          onClose={() => setNewFolderParent(null)}
        />
      )}

      <ConfirmDeleteDialog
        open={deletePath !== null}
        message={
          deleteItem
            ? `Delete "${deleteItem.name}"?${
                deleteItem.type === "directory"
                  ? " This will delete all its contents."
                  : ""
              }`
            : ""
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeletePath(null)}
      />

      {menu && (
        <ContextMenu
          items={menuItems}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
