import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  type DropSide,
  findFirstLeafId,
  findLeaf as findLeafUtil,
  recomputeSizes as recomputeSizesUtil,
  removeNode,
  replaceNode,
  sideToDirection,
  sourceFirstFromSide,
} from "@/lib/common/treeUtils";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface SftpConnectionState {
  sessionId: string | null;
  hostId: string | null;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  connecting: boolean;
  error: string | null;
}

interface SftpConnectResult {
  session_id: string;
  host: string;
  port: number;
  username: string;
  reused: boolean;
  host_id?: string;
}

interface SshConfig {
  host: string;
  port: number;
  username: string;
  private_key?: string;
  passphrase?: string;
}

interface SftpTransferProgress {
  session_id: string;
  transfer_id: string;
  transfer_type: string;
  path: string;
  bytes_transferred: number;
  total_bytes: number;
  speed: number;
}

const initialConnectionState: SftpConnectionState = {
  sessionId: null,
  hostId: null,
  host: "",
  port: 22,
  username: "",
  connected: false,
  connecting: false,
  error: null,
};

let progressUnlisten: (() => void) | null = null;

async function ensureProgressListener(
  get: () => SftpState,
  set: (partial: Partial<SftpState>) => void,
) {
  if (progressUnlisten) return;

  progressUnlisten = await listen<SftpTransferProgress>(
    "sftp-transfer-progress",
    (event) => {
      const { transfer_id, bytes_transferred, total_bytes, speed } =
        event.payload;
      const state = get();
      const transfer = state.transfers.find((t) => t.id === transfer_id);
      if (!transfer) return;

      const completed = bytes_transferred >= total_bytes;
      set({
        transfers: state.transfers.map((t) =>
          t.id === transfer_id
            ? {
                ...t,
                transferred: bytes_transferred,
                size: total_bytes,
                progress: total_bytes > 0 ? bytes_transferred / total_bytes : 0,
                speed,
                status: completed ? "complete" : "active",
              }
            : t,
        ),
      });
    },
  );
}

export interface SftpLeafNode {
  type: "leaf";
  id: string;
  connectionType: "host" | "local" | null;
  hostId?: string;
  hostName?: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  localPath?: string;
  size: number;
}

export interface SftpSplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: SftpPaneNode[];
  size: number;
}

export type SftpPaneNode = SftpLeafNode | SftpSplitNode;

export const findLeaf = findLeafUtil;

export interface FileDragState {
  isDragging: boolean;
  sourcePaneId: string | null;
  sourceHostId?: string | null;
  sourceDirect?: { host?: string; port?: number; username?: string };
  files: FileItem[];
}

export interface PendingFileDrop {
  paneId?: string;
  files: FileItem[];
  destPaneId?: string;
  sourceHostId?: string;
  destHostId?: string;
  destDirPath?: string;
  sourceDirect?: { host?: string; port?: number; username?: string };
  sourcePaneId?: string;
}

export interface TransferItem {
  id: string;
  fileName: string;
  localPath?: string;
  remotePath?: string;
  direction: "upload" | "download";
  status: "pending" | "active" | "complete" | "error";
  progress: number;
  size: number;
  transferred: number;
  speed?: number;
  error?: string;
}

export interface SftpErrorState {
  lastError: string | null;
  errorType: "connection" | "operation" | "transfer" | null;
}

interface SftpState {
  root: SftpPaneNode | null;
  activePaneId: string | null;
  focusedPaneId: string | null;
  fileDragState: FileDragState | null;
  pendingFileDrop: PendingFileDrop | null;
  transfers: TransferItem[];
  clipboard: {
    paths: string[];
    hostId: string;
    sourceDirect?: { host?: string; port?: number; username?: string };
  } | null;
  clipboardMode: "copy" | "cut" | null;
  refreshRequests: Record<string, number>;
  sftpConnection: SftpConnectionState;
  errorState: SftpErrorState;

  addPane: (leaf: SftpLeafNode) => void;
  removePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  setFocusedPane: (paneId: string | null) => void;
  setFileDragState: (state: FileDragState | null) => void;
  setPendingFileDrop: (drop: PendingFileDrop | null) => void;
  movePane: (
    sourcePaneId: string,
    targetPaneId: string,
    side: "left" | "right" | "top" | "bottom",
  ) => void;
  splitPane: (paneId: string, direction: "horizontal" | "vertical") => void;
  connectLocal: (paneId: string, localPath: string) => void;
  connectHost: (
    paneId: string,
    hostId: string,
    hostName: string,
    hostAddress?: string,
    hostPort?: number,
    hostUsername?: string,
  ) => void;
  setPaneSizes: (splitId: string, sizes: number[]) => void;
  addTransfer: (transfer: TransferItem) => void;
  updateTransfer: (id: string, data: Partial<TransferItem>) => void;
  removeTransfer: (id: string) => void;
  clearCompletedTransfers: () => void;
  setClipboard: (
    hostId: string,
    paths: string[],
    mode: "copy" | "cut",
    sourceDirect?: { host?: string; port?: number; username?: string },
  ) => void;
  clearClipboard: () => void;
  requestRefresh: (paneId: string) => void;
  setError: (error: string | null, type: SftpErrorState["errorType"]) => void;
  clearError: () => void;
  connectSftp: (hostId: string) => Promise<void>;
  connectSftpDirect: (config: SshConfig) => Promise<void>;
  disconnectSftp: () => Promise<void>;
}

let sftpPaneCounter = 0;
function nextSftpPaneId() {
  return `sftp-pane-${++sftpPaneCounter}-${Date.now()}`;
}

function makeEmptySftpLeaf(): SftpLeafNode {
  return {
    type: "leaf",
    id: nextSftpPaneId(),
    connectionType: null,
    size: 100,
  };
}

const initialErrorState: SftpErrorState = {
  lastError: null,
  errorType: null,
};

export const useSftpStore = create<SftpState>((set, get) => ({
  root: null,
  activePaneId: null,
  focusedPaneId: null,
  fileDragState: null,
  pendingFileDrop: null,
  transfers: [],
  clipboard: null,
  clipboardMode: null,
  refreshRequests: {},
  sftpConnection: { ...initialConnectionState },
  errorState: { ...initialErrorState },

  addPane: (leaf) => {
    const root = get().root;
    if (!root) {
      set({ root: leaf, activePaneId: leaf.id });
      return;
    }
    const split: SftpSplitNode = {
      type: "split",
      id: nextSftpPaneId(),
      direction: "horizontal",
      children: [
        { ...root, size: 50 },
        { ...leaf, size: 50 },
      ],
      size: 100,
    };
    set({ root: split, activePaneId: leaf.id });
  },

  removePane: (paneId) => {
    const root = get().root;
    if (!root) return;
    const newRoot = removeNode(root, paneId);
    if (!newRoot) {
      const fresh = makeEmptySftpLeaf();
      set({ root: fresh, activePaneId: fresh.id, focusedPaneId: null });
      return;
    }
    set({
      root: recomputeSizesUtil(newRoot),
      activePaneId:
        get().activePaneId === paneId
          ? findFirstLeafId(newRoot)
          : get().activePaneId,
      focusedPaneId:
        get().focusedPaneId === paneId ? null : get().focusedPaneId,
    });
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),
  setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),
  setFileDragState: (state) => set({ fileDragState: state }),
  setPendingFileDrop: (drop) => set({ pendingFileDrop: drop }),

  movePane: (sourcePaneId, targetPaneId, side) => {
    const root = get().root;
    if (!root) return;
    const sourceLeaf = findLeafUtil(root, sourcePaneId);
    if (!sourceLeaf) return;
    const withoutSource = removeNode(root, sourcePaneId);
    if (!withoutSource) return;
    const targetLeaf = findLeafUtil(withoutSource, targetPaneId);
    if (!targetLeaf) return;
    const direction = sideToDirection(side as DropSide);
    const sourceFirst = sourceFirstFromSide(side as DropSide);
    const newSplit: SftpSplitNode = {
      type: "split",
      id: nextSftpPaneId(),
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
    set({
      root: replaceNode(withoutSource, targetPaneId, newSplit),
      activePaneId: sourceLeaf.id,
    });
  },

  splitPane: (paneId, direction) => {
    const root = get().root;
    if (!root) return;
    const leaf = findLeafUtil(root, paneId);
    if (!leaf) return;
    const newLeaf = makeEmptySftpLeaf();
    const split: SftpSplitNode = {
      type: "split",
      id: nextSftpPaneId(),
      direction,
      children: [
        { ...leaf, size: 50 },
        { ...newLeaf, size: 50 },
      ],
      size: leaf.size,
    };
    set({
      root: replaceNode(root, paneId, split),
      activePaneId: newLeaf.id,
    });
  },

  connectLocal: (paneId, localPath) => {
    const root = get().root;
    if (!root) return;
    const leaf = findLeafUtil(root, paneId);
    if (!leaf) return;
    set({
      root: replaceNode(root, paneId, {
        ...leaf,
        connectionType: "local",
        localPath,
      }),
    });
  },

  connectHost: (
    paneId,
    hostId,
    hostName,
    hostAddress,
    hostPort,
    hostUsername,
  ) => {
    const root = get().root;
    if (!root) return;
    const leaf = findLeafUtil(root, paneId);
    if (!leaf) return;
    set({
      root: replaceNode(root, paneId, {
        ...leaf,
        connectionType: "host",
        hostId,
        hostName,
        hostAddress,
        hostPort,
        hostUsername,
      }),
    });
  },

  setPaneSizes: (splitId, sizes) => {
    const root = get().root;
    if (!root) return;
    function apply(node: SftpPaneNode): SftpPaneNode {
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
    set({ root: apply(root) });
  },

  addTransfer: (transfer) =>
    set((s) => ({ transfers: [...s.transfers, transfer] })),
  updateTransfer: (id, data) =>
    set((s) => ({
      transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...data } : t)),
    })),
  removeTransfer: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),
  clearCompletedTransfers: () =>
    set((s) => ({
      transfers: s.transfers.filter((t) => t.status !== "complete"),
    })),
  setClipboard: (hostId, paths, mode, sourceDirect) =>
    set({ clipboard: { paths, hostId, sourceDirect }, clipboardMode: mode }),
  clearClipboard: () => set({ clipboard: null, clipboardMode: null }),
  requestRefresh: (paneId) =>
    set((s) => ({
      refreshRequests: {
        ...s.refreshRequests,
        [paneId]: (s.refreshRequests[paneId] ?? 0) + 1,
      },
    })),
  setError: (error, type) =>
    set({ errorState: { lastError: error, errorType: type } }),
  clearError: () => set({ errorState: { ...initialErrorState } }),

  connectSftp: async (hostId: string) => {
    set({
      sftpConnection: {
        ...get().sftpConnection,
        connecting: true,
        error: null,
      },
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sessionId = `sftp-${hostId}-${Date.now()}`;
      const result = await invoke<SftpConnectResult>("sftp_connect_saved", {
        sessionId,
        hostId,
      });
      set({
        sftpConnection: {
          sessionId: result.session_id,
          hostId,
          host: result.host,
          port: result.port,
          username: result.username,
          connected: true,
          connecting: false,
          error: null,
        },
      });
      await ensureProgressListener(get, set);
    } catch (err) {
      set({
        sftpConnection: {
          ...get().sftpConnection,
          connecting: false,
          error: String(err),
        },
      });
    }
  },

  connectSftpDirect: async (config: SshConfig) => {
    set({
      sftpConnection: {
        ...get().sftpConnection,
        connecting: true,
        error: null,
      },
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sessionId = `sftp-direct-${Date.now()}`;
      const result = await invoke<SftpConnectResult>("sftp_connect", {
        sessionId,
        config,
      });
      set({
        sftpConnection: {
          sessionId: result.session_id,
          hostId: null,
          host: result.host,
          port: result.port,
          username: result.username,
          connected: true,
          connecting: false,
          error: null,
        },
      });
      await ensureProgressListener(get, set);
    } catch (err) {
      set({
        sftpConnection: {
          ...get().sftpConnection,
          connecting: false,
          error: String(err),
        },
      });
    }
  },

  disconnectSftp: async () => {
    const { sessionId } = get().sftpConnection;
    if (sessionId) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_disconnect", { sessionId });
      } catch {
        // best-effort disconnect
      }
    }
    if (progressUnlisten) {
      progressUnlisten();
      progressUnlisten = null;
    }
    set({ sftpConnection: { ...initialConnectionState } });
  },
}));
