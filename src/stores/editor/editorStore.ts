import { create } from "zustand";
import {
  type DropSide,
  findAllLeaves,
  findFirstLeafId,
  findLeaf as findLeafUtil,
  removeNode,
  replaceNode,
  sideToDirection,
  sourceFirstFromSide,
} from "@/lib/common/treeUtils";
import { ensureRemoteSession } from "@/lib/editor/editorProvider";
import type { FileItem } from "@/types/sftp/sftpTypes";

export const ROOT_VIEW_ID = "editor-view-root";

const SIDEBAR_WIDTH_KEY = "editor.sidebarWidth";
const SIDEBAR_VISIBLE_KEY = "editor.sidebarVisible";
const SIDEBAR_TOOL_KEY = "editor.sidebarTool";
export const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 640;

export type SidebarTool = "explorer" | "search" | "source-control";

function loadSidebarPrefs(): {
  sidebarWidth: number;
  sidebarVisible: boolean;
  sidebarTool: SidebarTool;
} {
  try {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    const visible = localStorage.getItem(SIDEBAR_VISIBLE_KEY);
    const tool = localStorage.getItem(SIDEBAR_TOOL_KEY);
    return {
      sidebarWidth:
        Number.isFinite(width) &&
        width >= MIN_SIDEBAR_WIDTH &&
        width <= MAX_SIDEBAR_WIDTH
          ? width
          : DEFAULT_SIDEBAR_WIDTH,
      sidebarVisible: visible !== "0",
      sidebarTool:
        tool === "search" || tool === "source-control" ? tool : "explorer",
    };
  } catch {
    return {
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarVisible: true,
      sidebarTool: "explorer",
    };
  }
}

export interface EditorOpenFile {
  path: string;
  name: string;
  kind?: "file" | "diff";
}

export interface EditorDirState {
  children: FileItem[] | null;
  expanded: boolean;
  error: string | null;
}

export interface EditorViewLeafNode {
  type: "leaf";
  id: string;
  size: number;
}

export interface EditorViewSplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: EditorViewNode[];
  size: number;
}

export type EditorViewNode = EditorViewLeafNode | EditorViewSplitNode;

export const findLeaf = findLeafUtil;

interface EditorState {
  connectionType: "host" | "local" | null;
  hostId?: string;
  hostName?: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  sessionId?: string;
  localPath?: string;

  viewTrees: EditorViewNode | null;
  activeView: string | null;
  openFiles: Record<string, EditorOpenFile[]>;
  activeFile: Record<string, string | null>;
  previewFile: Record<string, string | null>;
  fileContent: Record<string, string>;
  fileDirty: Record<string, boolean>;

  connectLocal: (localPath: string) => void;
  connectRemote: (payload: {
    hostId: string;
    hostName?: string;
    hostAddress?: string;
    hostPort?: number;
    hostUsername?: string;
    sessionId: string;
    rootPath: string;
    fileToOpen?: { path: string; name: string };
  }) => void;
  connectHost: (
    hostId: string,
    hostName: string,
    hostAddress?: string,
    hostPort?: number,
    hostUsername?: string,
  ) => void;
  disconnect: () => void;
  reconnect: () => Promise<boolean>;

  setFileContent: (path: string, value: string) => void;
  setFileDirty: (path: string, dirty: boolean) => void;

  openFile: (
    path: string,
    name: string,
    isPreview?: boolean,
    kind?: EditorOpenFile["kind"],
  ) => void;
  closeFile: (path: string) => void;
  revealRequest: {
    path: string;
    line: number;
    column?: number;
  } | null;
  setRevealRequest: (
    request: { path: string; line: number; column?: number } | null,
  ) => void;
  closeFileEverywhere: (path: string) => void;
  makeFilePermanent: (path: string) => void;
  setActiveFile: (path: string | null) => void;

  splitView: (viewId: string, direction: "horizontal" | "vertical") => void;
  removeView: (viewId: string) => void;
  setActiveView: (viewId: string) => void;
  setViewSizes: (splitId: string, sizes: number[]) => void;
  openFileInView: (
    viewId: string,
    path: string,
    name: string,
    isPreview?: boolean,
    kind?: EditorOpenFile["kind"],
  ) => void;
  closeFileInView: (viewId: string, path: string) => void;
  setActiveFileInView: (viewId: string, path: string | null) => void;
  makeFilePermanentInView: (viewId: string, path: string) => void;
  setFileOrder: (viewId: string, ordered: EditorOpenFile[]) => void;
  moveFileToView: (
    sourceViewId: string,
    targetViewId: string,
    path: string,
    name: string,
    side?: DropSide | null,
  ) => void;

  sidebarWidth: number;
  sidebarVisible: boolean;
  sidebarTool: SidebarTool;
  explorerDirs: Record<string, EditorDirState>;
  explorerSelectedPath: string | null;
  explorerRootPath: string | null;
  setSidebarWidth: (width: number) => void;
  setSidebarWidthRaw: (width: number) => void;
  setSidebarVisible: (visible: boolean) => void;
  setSidebarTool: (tool: SidebarTool) => void;

  statusVersion: number;
  bumpStatusVersion: () => void;

  quickOpenOpen: boolean;
  setQuickOpenOpen: (open: boolean) => void;
  setExplorerDir: (path: string, patch: Partial<EditorDirState>) => void;
  setExplorerDirs: (dirs: Record<string, EditorDirState>) => void;
  setExplorerSelectedPath: (path: string | null) => void;
  setExplorerRootPath: (path: string | null) => void;
}

let editorViewCounter = 0;
function nextEditorViewId() {
  return `editor-view-${++editorViewCounter}-${Date.now()}`;
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export function activeViewIdFor(
  viewTrees: EditorViewNode | null,
  activeView: string | null,
): string {
  if (!viewTrees) return ROOT_VIEW_ID;
  if (activeView && findLeafUtil(viewTrees, activeView)) return activeView;
  return findFirstLeafId(viewTrees) ?? ROOT_VIEW_ID;
}

export function useActiveViewId(): string {
  const viewTrees = useEditorStore((s) => s.viewTrees);
  const activeView = useEditorStore((s) => s.activeView);
  return activeViewIdFor(viewTrees, activeView);
}

function resetViews() {
  return {
    viewTrees: null as EditorViewNode | null,
    activeView: null,
    openFiles: {} as Record<string, EditorOpenFile[]>,
    activeFile: {} as Record<string, string | null>,
    previewFile: {} as Record<string, string | null>,
    fileContent: {} as Record<string, string>,
    fileDirty: {} as Record<string, boolean>,
    explorerDirs: {} as Record<string, EditorDirState>,
    explorerSelectedPath: null as string | null,
    explorerRootPath: null as string | null,
    revealRequest: null as {
      path: string;
      line: number;
      column?: number;
    } | null,
    sidebarTool: "explorer" as SidebarTool,
  };
}

export function hasDirtyFiles(state: {
  fileDirty: Record<string, boolean>;
}): boolean {
  return Object.values(state.fileDirty).some(Boolean);
}

export const useEditorStore = create<EditorState>((set, get) => ({
  connectionType: null,
  viewTrees: null,
  activeView: null,
  openFiles: {},
  activeFile: {},
  previewFile: {},
  fileContent: {},
  fileDirty: {},
  explorerDirs: {},
  explorerSelectedPath: null,
  explorerRootPath: null,
  quickOpenOpen: false,
  revealRequest: null,
  statusVersion: 0,
  ...loadSidebarPrefs(),

  connectLocal: (localPath) =>
    set({ connectionType: "local", localPath, ...resetViews() }),

  connectRemote: ({
    hostId,
    hostName,
    hostAddress,
    hostPort,
    hostUsername,
    sessionId,
    rootPath,
    fileToOpen,
  }) => {
    set({
      connectionType: "host",
      ...resetViews(),
      hostId,
      hostName,
      hostAddress,
      hostPort,
      hostUsername,
      sessionId,
      explorerRootPath: rootPath,
    });
    if (fileToOpen) {
      get().openFile(fileToOpen.path, fileToOpen.name, false);
    }
  },

  connectHost: (hostId, hostName, hostAddress, hostPort, hostUsername) =>
    set({
      connectionType: "host",
      hostId,
      hostName,
      hostAddress,
      hostPort,
      hostUsername,
      ...resetViews(),
    }),

  disconnect: () => set({ connectionType: null, ...resetViews() }),

  reconnect: async () => {
    const state = get();
    if (state.connectionType !== "host" || !state.hostId || !state.sessionId) {
      return false;
    }
    try {
      await ensureRemoteSession(state);
      return true;
    } catch {
      return false;
    }
  },

  setFileContent: (path, value) =>
    set({ fileContent: { ...get().fileContent, [path]: value } }),

  setFileDirty: (path, dirty) =>
    set({ fileDirty: { ...get().fileDirty, [path]: dirty } }),

  openFile: (path, name, isPreview = false, kind) => {
    const viewId = activeViewIdFor(get().viewTrees, get().activeView);
    get().openFileInView(viewId, path, name, isPreview, kind);
  },

  closeFile: (path) => {
    const viewId = activeViewIdFor(get().viewTrees, get().activeView);
    get().closeFileInView(viewId, path);
  },

  closeFileEverywhere: (path) => {
    const viewTrees = get().viewTrees;
    const ids = viewTrees
      ? [ROOT_VIEW_ID, ...findAllLeaves(viewTrees).map((l) => l.id)]
      : [ROOT_VIEW_ID];
    const openFiles = { ...get().openFiles };
    const activeFile = { ...get().activeFile };
    const previewFile = { ...get().previewFile };
    for (const viewId of ids) {
      const list = openFiles[viewId] ?? [];
      if (!list.some((f) => f.path === path)) continue;
      const next = list.filter((f) => f.path !== path);
      if (activeFile[viewId] === path) {
        const idx = list.findIndex((f) => f.path === path);
        activeFile[viewId] = next[idx]?.path ?? next[idx - 1]?.path ?? null;
      }
      if (previewFile[viewId] === path) previewFile[viewId] = null;
      openFiles[viewId] = next;
    }
    set({ openFiles, activeFile, previewFile });
  },

  makeFilePermanent: (path) => {
    const viewId = activeViewIdFor(get().viewTrees, get().activeView);
    get().makeFilePermanentInView(viewId, path);
  },

  setActiveFile: (path) => {
    const viewId = activeViewIdFor(get().viewTrees, get().activeView);
    get().setActiveFileInView(viewId, path);
  },

  splitView: (viewId, direction) => {
    const existing =
      get().viewTrees ??
      ({
        type: "leaf",
        id: ROOT_VIEW_ID,
        size: 100,
      } as EditorViewNode);
    const leaf = findLeafUtil(existing, viewId);
    if (!leaf) return;
    const newLeaf: EditorViewLeafNode = {
      type: "leaf",
      id: nextEditorViewId(),
      size: 50,
    };
    const split: EditorViewSplitNode = {
      type: "split",
      id: nextEditorViewId(),
      direction,
      children: [{ ...leaf, size: 50 }, newLeaf],
      size: leaf.size,
    };
    set({
      viewTrees: replaceNode(existing, viewId, split),
      activeView: newLeaf.id,
    });
  },

  removeView: (viewId) => {
    const tree = get().viewTrees;
    if (!tree) return;
    const removed = removeNode(tree, viewId);
    if (!removed) return;
    const leaves = findAllLeaves(removed);
    const cleanedOpen = withoutKey(get().openFiles, viewId);
    const cleanedActive = withoutKey(get().activeFile, viewId);
    const cleanedPreview = withoutKey(get().previewFile, viewId);
    const nextTree =
      leaves.length === 1 && leaves[0].id === ROOT_VIEW_ID ? null : removed;
    set({
      viewTrees: nextTree,
      activeView:
        get().activeView === viewId
          ? nextTree
            ? (findFirstLeafId(nextTree) ?? ROOT_VIEW_ID)
            : ROOT_VIEW_ID
          : get().activeView,
      openFiles: cleanedOpen,
      activeFile: cleanedActive,
      previewFile: cleanedPreview,
    });
  },

  setActiveView: (viewId) => set({ activeView: viewId }),

  setViewSizes: (splitId, sizes) => {
    const tree = get().viewTrees;
    if (!tree) return;
    function apply(node: EditorViewNode): EditorViewNode {
      if (node.type === "leaf") return node;
      if (node.id === splitId) {
        return {
          ...node,
          children: node.children.map((c, i) => ({
            ...c,
            size: sizes[i] ?? c.size,
          })),
        };
      }
      return { ...node, children: node.children.map(apply) };
    }
    set({ viewTrees: apply(tree) });
  },

  openFileInView: (viewId, path, name, isPreview = false, kind = "file") => {
    const existing = get().openFiles[viewId] ?? [];
    const currentPreview = get().previewFile[viewId] ?? null;

    if (existing.some((f) => f.path === path)) {
      set({
        activeFile: { ...get().activeFile, [viewId]: path },
        previewFile: {
          ...get().previewFile,
          [viewId]: isPreview ? currentPreview : null,
        },
        activeView: viewId,
      });
      return;
    }

    let next = [...existing, { path, name, kind }];
    let preview = currentPreview;

    if (isPreview) {
      if (currentPreview && currentPreview !== path) {
        next = next.filter((f) => f.path !== currentPreview);
      }
      preview = path;
    } else {
      preview = null;
    }

    set({
      openFiles: { ...get().openFiles, [viewId]: next },
      activeFile: { ...get().activeFile, [viewId]: path },
      previewFile: { ...get().previewFile, [viewId]: preview },
      activeView: viewId,
    });
  },

  closeFileInView: (viewId, path) => {
    const list = get().openFiles[viewId] ?? [];
    const next = list.filter((f) => f.path !== path);
    let active = get().activeFile[viewId] ?? null;
    if (active === path) {
      const idx = list.findIndex((f) => f.path === path);
      active = next[idx]?.path ?? next[idx - 1]?.path ?? null;
    }
    const preview =
      get().previewFile[viewId] === path ? null : get().previewFile[viewId];
    set({
      openFiles: { ...get().openFiles, [viewId]: next },
      activeFile: { ...get().activeFile, [viewId]: active },
      previewFile: { ...get().previewFile, [viewId]: preview },
      activeView: viewId,
    });
  },

  setActiveFileInView: (viewId, path) =>
    set({ activeFile: { ...get().activeFile, [viewId]: path } }),

  makeFilePermanentInView: (viewId, path) => {
    if (get().previewFile[viewId] !== path) return;
    set({
      previewFile: { ...get().previewFile, [viewId]: null },
    });
  },

  setFileOrder: (viewId, ordered) =>
    set({ openFiles: { ...get().openFiles, [viewId]: ordered } }),

  moveFileToView: (sourceViewId, targetViewId, path, name, side = null) => {
    const sourceList = get().openFiles[sourceViewId] ?? [];
    if (!sourceList.some((f) => f.path === path)) return;
    const targetList = get().openFiles[targetViewId] ?? [];

    const tree: EditorViewNode = get().viewTrees ?? {
      type: "leaf",
      id: ROOT_VIEW_ID,
      size: 100,
    };
    const targetLeaf = findLeafUtil(tree, targetViewId);
    if (!targetLeaf) return;

    let resolvedTarget = targetViewId;
    let nextTree: EditorViewNode | null = tree;

    if (side) {
      const newLeaf: EditorViewLeafNode = {
        type: "leaf",
        id: nextEditorViewId(),
        size: 50,
      };
      const direction = sideToDirection(side);
      const sourceFirst = sourceFirstFromSide(side);
      const split: EditorViewSplitNode = {
        type: "split",
        id: nextEditorViewId(),
        direction,
        children: sourceFirst
          ? [newLeaf, { ...targetLeaf, size: 50 }]
          : [{ ...targetLeaf, size: 50 }, newLeaf],
        size: targetLeaf.size,
      };
      nextTree = replaceNode(tree, targetViewId, split);
      resolvedTarget = newLeaf.id;
    }

    const nextSource = sourceList.filter((f) => f.path !== path);
    const nextTarget =
      resolvedTarget !== targetViewId
        ? [{ path, name }]
        : targetList.some((f) => f.path === path)
          ? targetList
          : [...targetList, { path, name }];

    let sourceEmpty = false;
    if (nextSource.length === 0 && sourceViewId !== targetViewId) {
      sourceEmpty = true;
      nextTree = removeNode(nextTree, sourceViewId);
      if (nextTree) {
        const leaves = findAllLeaves(nextTree);
        if (leaves.length === 1 && leaves[0].id === ROOT_VIEW_ID) {
          nextTree = null;
        }
      }
    }

    set({
      viewTrees: nextTree === tree ? get().viewTrees : nextTree,
      openFiles: sourceEmpty
        ? withoutKey(
            { ...get().openFiles, [resolvedTarget]: nextTarget },
            sourceViewId,
          )
        : {
            ...get().openFiles,
            [sourceViewId]: nextSource,
            [resolvedTarget]: nextTarget,
          },
      activeFile: sourceEmpty
        ? withoutKey(
            { ...get().activeFile, [resolvedTarget]: path },
            sourceViewId,
          )
        : {
            ...get().activeFile,
            [sourceViewId]:
              get().activeFile[sourceViewId] === path
                ? (nextSource[0]?.path ?? null)
                : get().activeFile[sourceViewId],
            [resolvedTarget]: path,
          },
      previewFile: sourceEmpty
        ? withoutKey(
            {
              ...get().previewFile,
              [resolvedTarget]:
                get().previewFile[resolvedTarget] === path
                  ? get().previewFile[resolvedTarget]
                  : null,
            },
            sourceViewId,
          )
        : {
            ...get().previewFile,
            [sourceViewId]:
              get().previewFile[sourceViewId] === path
                ? null
                : get().previewFile[sourceViewId],
            [resolvedTarget]:
              get().previewFile[resolvedTarget] === path
                ? get().previewFile[resolvedTarget]
                : null,
          },
      activeView: resolvedTarget,
    });
  },

  setSidebarWidth: (width) => {
    const clamped = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, width),
    );
    set({ sidebarWidth: clamped });
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
    } catch {
      /* storage unavailable */
    }
  },

  setSidebarWidthRaw: (width) => set({ sidebarWidth: width }),

  setSidebarVisible: (visible) => {
    set({ sidebarVisible: visible });
    try {
      localStorage.setItem(SIDEBAR_VISIBLE_KEY, visible ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  },

  setSidebarTool: (tool) => {
    set({ sidebarTool: tool });
    try {
      localStorage.setItem(SIDEBAR_TOOL_KEY, tool);
    } catch {
      /* storage unavailable */
    }
  },

  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),

  bumpStatusVersion: () => set({ statusVersion: get().statusVersion + 1 }),

  setRevealRequest: (request) => set({ revealRequest: request }),

  setExplorerDir: (path, patch) => {
    const existing = get().explorerDirs[path] ?? {
      children: null,
      expanded: false,
      error: null,
    };
    set({
      explorerDirs: {
        ...get().explorerDirs,
        [path]: { ...existing, ...patch },
      },
    });
  },

  setExplorerDirs: (dirs) => set({ explorerDirs: dirs }),

  setExplorerSelectedPath: (path) => set({ explorerSelectedPath: path }),

  setExplorerRootPath: (path) => set({ explorerRootPath: path }),
}));
