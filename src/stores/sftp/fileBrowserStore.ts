import { create } from "zustand";
import type {
  FileItem,
  FileSortDirection,
  FileSortField,
  FileViewMode,
} from "@/types/sftp/sftpTypes";

export interface PasteConflict {
  srcPath: string;
  dstPath: string;
  dstName: string;
}

export interface PendingDrop {
  files: FileItem[];
  destDirPath: string;
  mode: "move" | "copy";
  sourceHostId?: string;
  sourcePaneId?: string;
  sourceDirect?: { host?: string; port?: number; username?: string };
  sourceKind?: "drag" | "clipboard";
}

interface FileBrowserPane {
  paneId: string;
  files: FileItem[];
  currentPath: string;
  isLoading: boolean;
  error: string | null;
  selectedFiles: Set<string>;
  viewMode: FileViewMode;
  showHidden: boolean;
  sortField: FileSortField;
  sortDirection: FileSortDirection;
  searchQuery: string;
  recursiveSearch: boolean;
  renamingPath: string | null;
  renameValue: string;
  lastSelectedIndex: number | null;
  history: string[];
  historyIndex: number;
  pasteConflicts: PasteConflict[] | null;
  pendingDrop: PendingDrop | null;
  initialized: boolean;
  sortedFiles: FileItem[];
}

function createPaneState(paneId: string, initialPath: string): FileBrowserPane {
  return {
    paneId,
    files: [],
    currentPath: initialPath,
    isLoading: false,
    error: null,
    selectedFiles: new Set<string>(),
    viewMode: "list",
    showHidden: false,
    sortField: "name",
    sortDirection: "asc",
    searchQuery: "",
    recursiveSearch: false,
    renamingPath: null,
    renameValue: "",
    lastSelectedIndex: null,
    history: [initialPath],
    historyIndex: 0,
    pasteConflicts: null,
    pendingDrop: null,
    initialized: false,
    sortedFiles: [],
  };
}

interface FileBrowserStore {
  panes: Record<string, FileBrowserPane>;
  activePaneId: string | null;
  getOrCreatePane: (paneId: string, initialPath: string) => FileBrowserPane;
  updatePane: (paneId: string, patch: Partial<FileBrowserPane>) => void;
  setActivePane: (paneId: string) => void;
}

export const useFileBrowserStore = create<FileBrowserStore>((set, get) => ({
  panes: {},
  activePaneId: null,

  getOrCreatePane: (paneId, initialPath) => {
    if (get().panes[paneId]) return get().panes[paneId];
    const pane = createPaneState(paneId, initialPath);
    set((state) => ({
      panes: { ...state.panes, [paneId]: pane },
    }));
    return pane;
  },

  updatePane: (paneId, patch) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: { ...state.panes[paneId], ...patch },
      },
    }));
  },

  setActivePane: (paneId) => {
    set({ activePaneId: paneId });
  },
}));

// ── Actions (called by components via getStore().actionName(paneId, ...)) ────

function update(paneId: string, patch: Partial<FileBrowserPane>) {
  useFileBrowserStore.getState().updatePane(paneId, patch);
}

function pane(paneId: string): FileBrowserPane | undefined {
  return useFileBrowserStore.getState().panes[paneId];
}

export const fileBrowserActions = {
  async loadFiles(
    paneId: string,
    path: string,
    provider: (path: string) => Promise<FileItem[]>,
  ) {
    update(paneId, { isLoading: true, error: null });
    try {
      const files = await provider(path);
      update(paneId, {
        files,
        currentPath: path,
        isLoading: false,
        initialized: true,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load directory";
      update(paneId, {
        error: message,
        isLoading: false,
        files: [],
        initialized: true,
      });
    }
  },

  navigateTo(paneId: string, path: string, skipHistory = false) {
    const p = pane(paneId);
    if (!p) return;
    update(paneId, {
      currentPath: path,
      selectedFiles: new Set<string>(),
      searchQuery: "",
      ...(skipHistory
        ? {}
        : {
            history: [...p.history.slice(0, p.historyIndex + 1), path],
            historyIndex: p.historyIndex + 1,
          }),
    });
  },

  navigateBack(paneId: string) {
    const p = pane(paneId);
    if (!p || p.historyIndex <= 0) return;
    const newIndex = p.historyIndex - 1;
    update(paneId, {
      currentPath: p.history[newIndex],
      historyIndex: newIndex,
      selectedFiles: new Set<string>(),
      searchQuery: "",
    });
  },

  navigateForward(paneId: string) {
    const p = pane(paneId);
    if (!p || p.historyIndex >= p.history.length - 1) return;
    const newIndex = p.historyIndex + 1;
    update(paneId, {
      currentPath: p.history[newIndex],
      historyIndex: newIndex,
      selectedFiles: new Set<string>(),
      searchQuery: "",
    });
  },

  navigateUp(paneId: string) {
    const p = pane(paneId);
    if (!p) return;
    const sep = p.currentPath.includes("\\") ? "\\" : "/";
    const parts = p.currentPath.split(sep);
    parts.pop();
    let parent = parts.join(sep);
    if (sep === "\\" && parent && !parent.endsWith("\\")) {
      parent = `${parent}\\`;
    } else {
      parent = parent || sep;
    }
    fileBrowserActions.navigateTo(paneId, parent);
  },

  clearSelection(paneId: string) {
    update(paneId, { selectedFiles: new Set<string>() });
  },

  selectFile(
    paneId: string,
    fileName: string,
    isMultiSelect: boolean,
    isRangeSelect: boolean,
    sortedFiles: FileItem[],
  ) {
    const p = pane(paneId);
    if (!p) return;

    let next: Set<string>;
    let newIndex = p.lastSelectedIndex;

    if (isRangeSelect && p.lastSelectedIndex !== null) {
      const clickedIndex = sortedFiles.findIndex((f) => f.name === fileName);
      if (clickedIndex === -1) return;
      const start = Math.min(p.lastSelectedIndex, clickedIndex);
      const end = Math.max(p.lastSelectedIndex, clickedIndex);
      next = new Set(p.selectedFiles);
      for (let i = start; i <= end; i++) {
        next.add(sortedFiles[i].name);
      }
    } else {
      next = new Set(isMultiSelect ? p.selectedFiles : []);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      newIndex = sortedFiles.findIndex((f) => f.name === fileName);
    }

    update(paneId, { selectedFiles: next, lastSelectedIndex: newIndex });
  },

  startRename(paneId: string, filePath: string, fileName: string) {
    update(paneId, { renamingPath: filePath, renameValue: fileName });
  },

  cancelRename(paneId: string) {
    update(paneId, { renamingPath: null });
  },

  setFiles(paneId: string, files: FileItem[]) {
    update(paneId, { files });
  },

  clearError(paneId: string) {
    update(paneId, { error: null });
  },

  setPasteConflicts(paneId: string, conflicts: PasteConflict[] | null) {
    update(paneId, { pasteConflicts: conflicts });
  },

  setPendingDrop(paneId: string, drop: PendingDrop | null) {
    update(paneId, { pendingDrop: drop });
  },

  setSearchQuery(paneId: string, query: string) {
    update(paneId, { searchQuery: query });
  },

  setRecursiveSearch(paneId: string, recursive: boolean) {
    update(paneId, { recursiveSearch: recursive });
  },

  setShowHidden(paneId: string, show: boolean) {
    update(paneId, { showHidden: show });
  },

  setViewMode(paneId: string, mode: FileViewMode) {
    update(paneId, { viewMode: mode });
  },

  setSortField(paneId: string, field: FileSortField) {
    update(paneId, { sortField: field });
  },

  setSortDirection(
    paneId: string,
    fn: (d: FileSortDirection) => FileSortDirection,
  ) {
    const p = pane(paneId);
    if (!p) return;
    update(paneId, { sortDirection: fn(p.sortDirection) });
  },

  setRenameValue(paneId: string, value: string) {
    update(paneId, { renameValue: value });
  },

  setRenamingPath(paneId: string, path: string | null) {
    update(paneId, { renamingPath: path });
  },

  updateSortedFiles(paneId: string) {
    const p = pane(paneId);
    if (!p) return;
    const sorted = [...p.files]
      .filter(
        (f) =>
          (p.showHidden || !f.isHidden) &&
          (p.searchQuery === "" ||
            f.name.toLowerCase().includes(p.searchQuery.toLowerCase())),
      )
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        let cmp = 0;
        if (p.sortField === "name") cmp = a.name.localeCompare(b.name);
        else if (p.sortField === "size") cmp = a.size - b.size;
        else if (p.sortField === "type") {
          const rank = (t: string) =>
            t === "directory" ? 0 : t === "symlink" ? 1 : 2;
          cmp = rank(a.type) - rank(b.type) || a.name.localeCompare(b.name);
        } else if (p.sortField === "permissions")
          cmp = a.permissions.localeCompare(b.permissions);
        else if (p.sortField === "modifiedAt")
          cmp =
            new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
        else if (p.sortField === "accessedAt")
          cmp =
            new Date(a.accessedAt ?? a.modifiedAt).getTime() -
            new Date(b.accessedAt ?? b.modifiedAt).getTime();
        return p.sortDirection === "asc" ? cmp : -cmp;
      });
    update(paneId, { sortedFiles: sorted });
  },

  resetPane(paneId: string, rootPath?: string) {
    const p = pane(paneId);
    if (!p) return;
    // The pane may be reconnected as a different kind (local <-> remote):
    // reset currentPath/history to the given root so a stale path from the
    // previous connection isn't loaded against the new provider.
    const root = rootPath ?? p.currentPath;
    update(paneId, {
      files: [],
      currentPath: root,
      selectedFiles: new Set<string>(),
      error: null,
      isLoading: false,
      searchQuery: "",
      renamingPath: null,
      pasteConflicts: null,
      pendingDrop: null,
      initialized: false,
      sortedFiles: [],
      history: [root],
      historyIndex: 0,
    });
  },

  setActivePane(paneId: string) {
    useFileBrowserStore.getState().setActivePane(paneId);
  },
};
