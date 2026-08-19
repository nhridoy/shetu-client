import { create } from "zustand";
import {
  countLeaves as countLeavesUtil,
  type DropSide,
  findFirstLeafId,
  findLeaf as findLeafUtil,
  recomputeSizes as recomputeSizesUtil,
  removeNode,
  replaceNode,
  sideToDirection,
  sourceFirstFromSide,
} from "@/lib/common/treeUtils";

type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface LeafNode {
  type: "leaf";
  id: string;
  hostId?: string;
  hostName: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  authType?: "password" | "key" | "both" | "none";
  keyId?: string;
  connectionType?: "ssh" | "local";
  shell?: string;
  title: string;
  connectionStatus: ConnectionStatus;
  lastConnected?: string;
  size: number;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: PaneNode[];
  size: number;
}

export type PaneNode = LeafNode | SplitNode;

export interface WorkspaceLayout {
  tabs: Array<{
    title: string;
    root: PaneNode;
  }>;
}

export interface TerminalTab {
  id: string;
  root: PaneNode;
  activePaneId: string | null;
  focusedPaneId: string | null;
  isActive: boolean;
  title: string;
  activePresetId: string | null;
  activePresetName: string | null;
  savedPresetSnapshot: string;
  presetDirty: boolean;
}

export const findLeaf = findLeafUtil;

export function computeTabSnapshot(_root: PaneNode): string {
  return "";
}

export function serializeWorkspaceLayout(_tabs: TerminalTab[]): {
  tabs: Array<{ title: string; root: PaneNode }>;
  hostIds: string[];
} {
  return { tabs: [], hostIds: [] };
}

interface ConnectOptions {
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  authType?: "password" | "key" | "both" | "none";
  keyId?: string;
  connectionType?: "ssh" | "local";
  shell?: string;
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  isDirty: boolean;
  savedSnapshot: string;

  addTab: (hostId: string, hostName: string, options?: ConnectOptions) => void;
  addEmptyTab: () => string;
  connectPane: (
    tabId: string,
    paneId: string,
    hostId: string,
    hostName: string,
    options?: ConnectOptions,
  ) => void;
  connectActivePane: (
    tabId: string,
    hostId: string,
    hostName: string,
    options?: ConnectOptions,
  ) => void;
  splitPane: (
    tabId: string,
    paneId: string,
    direction: "horizontal" | "vertical",
  ) => string;
  removePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  setFocusedPane: (tabId: string, paneId: string | null) => void;
  setActiveTab: (id: string) => void;
  updatePaneConnectionStatus: (
    tabId: string,
    paneId: string,
    status: ConnectionStatus,
  ) => void;
  updatePaneTitle: (tabId: string, paneId: string, title: string) => void;
  setPaneSizes: (tabId: string, splitId: string, sizes: number[]) => void;
  removeTab: (id: string) => void;
  closeAllTabs: () => void;
  reorderTabs: (draggedId: string, targetId: string, before: boolean) => void;
  setTabOrder: (ids: string[]) => void;
  movePane: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    side: "left" | "right" | "top" | "bottom",
  ) => void;
  mergeTabIntoPane: (
    sourceTabId: string,
    targetTabId: string,
    targetPaneId: string,
    side: "left" | "right" | "top" | "bottom",
  ) => void;
  launchWorkspace: (
    layout: WorkspaceLayout,
    workspaceId?: string,
    workspaceName?: string,
  ) => void;
  restorePreset: (
    preset: { id?: string; name?: string; layout: string },
    tabId: string,
  ) => void;
  saveCurrentPreset: (tabId: string) => Promise<void>;
  setPresetForTab: (
    tabId: string,
    presetId: string,
    presetName: string,
  ) => void;
  saveCurrentWorkspace: () => Promise<void>;
  saveAsNewWorkspace: (name: string, vaultId?: string) => Promise<void>;
}

let tabCounter = 0;
let paneCounter = 0;
function nextTabId() {
  return `tab-${++tabCounter}-${Date.now()}`;
}
function nextPaneId() {
  return `pane-${++paneCounter}-${Date.now()}`;
}

function makeEmptyLeaf(): LeafNode {
  return {
    type: "leaf",
    id: nextPaneId(),
    hostName: "",
    title: "Empty",
    connectionStatus: "disconnected",
    size: 100,
  };
}

function findTab(tabs: TerminalTab[], tabId: string): TerminalTab | undefined {
  return tabs.find((t) => t.id === tabId);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  isDirty: false,
  savedSnapshot: "",

  addTab: (hostId, hostName, options) => {
    const leaf: LeafNode = {
      type: "leaf",
      id: nextPaneId(),
      hostId,
      hostName,
      hostAddress: options?.hostAddress,
      hostPort: options?.hostPort,
      hostUsername: options?.hostUsername,
      authType: options?.authType,
      keyId: options?.keyId,
      connectionType: options?.connectionType,
      shell: options?.shell,
      title: hostName,
      connectionStatus: "connecting",
      size: 100,
    };
    const tabId = nextTabId();
    const tab: TerminalTab = {
      id: tabId,
      root: leaf,
      activePaneId: leaf.id,
      focusedPaneId: null,
      isActive: true,
      title: hostName,
      activePresetId: null,
      activePresetName: null,
      savedPresetSnapshot: "",
      presetDirty: false,
    };
    set((s) => ({
      tabs: [...s.tabs.map((t) => ({ ...t, isActive: false })), tab],
      activeTabId: tabId,
    }));
  },

  addEmptyTab: () => {
    const leaf = makeEmptyLeaf();
    const tabId = nextTabId();
    const tab: TerminalTab = {
      id: tabId,
      root: leaf,
      activePaneId: leaf.id,
      focusedPaneId: null,
      isActive: true,
      title: "New Tab",
      activePresetId: null,
      activePresetName: null,
      savedPresetSnapshot: "",
      presetDirty: false,
    };
    set((s) => ({
      tabs: [...s.tabs.map((t) => ({ ...t, isActive: false })), tab],
      activeTabId: tabId,
    }));
    return tabId;
  },

  connectPane: (tabId, paneId, hostId, hostName, options) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const leaf = findLeafUtil(tab.root, paneId);
        if (!leaf) return tab;
        const updated: LeafNode = {
          ...leaf,
          hostId,
          hostName,
          hostAddress: options?.hostAddress,
          hostPort: options?.hostPort,
          hostUsername: options?.hostUsername,
          authType: options?.authType,
          keyId: options?.keyId,
          connectionType: options?.connectionType,
          shell: options?.shell,
          title: hostName,
          connectionStatus: "connecting",
        };
        return {
          ...tab,
          root: replaceNode(tab.root, paneId, updated),
          title: countLeavesUtil(tab.root) === 1 ? hostName : tab.title,
        };
      }),
    }));
  },

  connectActivePane: (tabId, hostId, hostName, options) => {
    const { tabs } = get();
    const tab = findTab(tabs, tabId);
    if (!tab?.activePaneId) return;
    get().connectPane(tabId, tab.activePaneId, hostId, hostName, options);
  },

  splitPane: (tabId, paneId, direction) => {
    const newPaneId = nextPaneId();
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const leaf = findLeafUtil(tab.root, paneId);
        if (!leaf) return tab;
        const newLeaf: LeafNode = {
          type: "leaf",
          id: newPaneId,
          hostName: "",
          title: "Empty",
          connectionStatus: "disconnected",
          size: 50,
        };
        const existingLeaf: LeafNode = { ...leaf, size: 50 };
        const split: SplitNode = {
          type: "split",
          id: nextPaneId(),
          direction,
          children: [existingLeaf, newLeaf],
          size: leaf.size,
        };
        return {
          ...tab,
          root: replaceNode(tab.root, paneId, split),
          activePaneId: newPaneId,
        };
      }),
      activeTabId: tabId,
    }));
    return newPaneId;
  },

  removePane: (tabId, paneId) => {
    set((s) => {
      const tab = findTab(s.tabs, tabId);
      if (!tab) return s;
      const newRoot = removeNode(tab.root, paneId);
      if (!newRoot) {
        const remaining = s.tabs.filter((t) => t.id !== tabId);
        return {
          tabs: remaining,
          activeTabId:
            s.activeTabId === tabId
              ? (remaining.at(-1)?.id ?? null)
              : s.activeTabId,
        };
      }
      const re = recomputeSizesUtil(newRoot);
      return {
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const fallbackActive = findFirstLeafId(re);
          return {
            ...t,
            root: re,
            activePaneId:
              t.activePaneId === paneId ? fallbackActive : t.activePaneId,
            focusedPaneId: t.focusedPaneId === paneId ? null : t.focusedPaneId,
          };
        }),
      };
    });
  },

  setActivePane: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, activePaneId: paneId } : t,
      ),
      activeTabId: tabId,
    }));
  },

  setFocusedPane: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, focusedPaneId: paneId } : t,
      ),
    }));
  },

  setActiveTab: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, isActive: t.id === id })),
      activeTabId: id,
    }));
  },

  updatePaneConnectionStatus: (tabId, paneId, status) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const leaf = findLeafUtil(tab.root, paneId);
        if (!leaf) return tab;
        return {
          ...tab,
          root: replaceNode(tab.root, paneId, {
            ...leaf,
            connectionStatus: status,
          }),
        };
      }),
    }));
  },

  updatePaneTitle: (tabId, paneId, title) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const leaf = findLeafUtil(tab.root, paneId);
        if (!leaf) return tab;
        return {
          ...tab,
          root: replaceNode(tab.root, paneId, { ...leaf, title }),
        };
      }),
    }));
  },

  setPaneSizes: (tabId, splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        function apply(node: PaneNode): PaneNode {
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
        return { ...tab, root: apply(tab.root) };
      }),
    }));
  },

  removeTab: (id) => {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      return {
        tabs: remaining,
        activeTabId:
          s.activeTabId === id ? (remaining.at(-1)?.id ?? null) : s.activeTabId,
      };
    });
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTabId: null });
  },

  reorderTabs: (draggedId, targetId, before) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === draggedId);
      if (idx === -1) return s;
      const tab = s.tabs[idx];
      const rest = s.tabs.filter((t) => t.id !== draggedId);
      const targetIdx = rest.findIndex((t) => t.id === targetId);
      if (targetIdx === -1) return { tabs: [...rest, tab] };
      rest.splice(before ? targetIdx : targetIdx + 1, 0, tab);
      return { tabs: rest };
    });
  },

  setTabOrder: (ids) => {
    set((s) => {
      const map = new Map(s.tabs.map((t) => [t.id, t]));
      return {
        tabs: ids.map((id) => map.get(id)).filter((t): t is TerminalTab => !!t),
      };
    });
  },

  movePane: (tabId, sourcePaneId, targetPaneId, side) => {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const sourceLeaf = findLeafUtil(tab.root, sourcePaneId);
        if (!sourceLeaf) return tab;
        const withoutSource = removeNode(tab.root, sourcePaneId);
        if (!withoutSource) return tab;
        const targetLeaf = findLeafUtil(withoutSource, targetPaneId);
        if (!targetLeaf) return tab;
        const direction = sideToDirection(side as DropSide);
        const sourceFirst = sourceFirstFromSide(side as DropSide);
        const newSplit: SplitNode = {
          type: "split",
          id: nextPaneId(),
          direction,
          children: sourceFirst
            ? [
                { ...sourceLeaf, size: 50 },
                { ...targetLeaf, size: 50 },
              ]
            : [
                { ...targetLeaf, size: 50 },
                { ...sourceLeaf, size: 50 },
              ],
          size: targetLeaf.size,
        };
        return {
          ...tab,
          root: replaceNode(withoutSource, targetPaneId, newSplit),
          activePaneId: sourceLeaf.id,
        };
      }),
    }));
  },

  mergeTabIntoPane: (sourceTabId, targetTabId, targetPaneId, side) => {
    set((s) => {
      const sourceTab = findTab(s.tabs, sourceTabId);
      const targetTab = findTab(s.tabs, targetTabId);
      if (!sourceTab || !targetTab) return s;
      const targetLeaf = findLeafUtil(targetTab.root, targetPaneId);
      if (!targetLeaf) return s;
      const direction = sideToDirection(side as DropSide);
      const sourceFirst = sourceFirstFromSide(side as DropSide);
      const newSplit: SplitNode = {
        type: "split",
        id: nextPaneId(),
        direction,
        children: sourceFirst
          ? [
              { ...sourceTab.root, size: 50 },
              { ...targetLeaf, size: 50 },
            ]
          : [
              { ...targetLeaf, size: 50 },
              { ...sourceTab.root, size: 50 },
            ],
        size: targetLeaf.size,
      };
      const remainingTabs = s.tabs.filter((t) => t.id !== sourceTabId);
      return {
        tabs: remainingTabs.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                root: replaceNode(t.root, targetPaneId, newSplit),
              }
            : t,
        ),
        activeTabId: targetTabId,
      };
    });
  },

  launchWorkspace: (layout, workspaceId, workspaceName) => {
    const tabs: TerminalTab[] = layout.tabs.map((t, i) => {
      const tabId = nextTabId();
      return {
        id: tabId,
        root: t.root,
        activePaneId:
          t.root.type === "leaf"
            ? t.root.id
            : t.root.children[0]?.type === "leaf"
              ? t.root.children[0].id
              : null,
        focusedPaneId: null,
        isActive: i === layout.tabs.length - 1,
        title: t.title,
        activePresetId: null,
        activePresetName: null,
        savedPresetSnapshot: "",
        presetDirty: false,
      };
    });
    const activeTabId = tabs.at(-1)?.id ?? null;
    set({
      tabs,
      activeTabId,
      activeWorkspaceId: workspaceId ?? null,
      activeWorkspaceName: workspaceName ?? null,
    });
  },

  restorePreset: (preset, tabId) => {
    let root: PaneNode;
    try {
      root = JSON.parse(preset.layout);
    } catch {
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        return {
          ...t,
          root,
          activePaneId:
            root.type === "leaf"
              ? root.id
              : root.children[0]?.type === "leaf"
                ? root.children[0].id
                : t.activePaneId,
          focusedPaneId: null,
          activePresetId: preset.id ?? null,
          activePresetName: preset.name ?? null,
          presetDirty: false,
        };
      }),
    }));
  },

  saveCurrentPreset: async () => {},

  setPresetForTab: (tabId, presetId, presetName) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, activePresetId: presetId, activePresetName: presetName }
          : t,
      ),
    }));
  },

  saveCurrentWorkspace: async () => {},
  saveAsNewWorkspace: async () => {},
}));
