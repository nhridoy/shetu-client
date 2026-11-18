import { toast } from "sonner";
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
import {
  clearFinishedTransfers,
  listTransfers,
  onTransfersChanged,
  onTransfersReset,
  resumeAllTransfers,
  type TransferJob,
} from "@/lib/sftp/transfers";
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

let transferListener: Promise<void> | null = null;

/** Loads the manager's queue once and mirrors its changes; offers Resume all after a restart. */
function startTransferListener(
  apply: (jobs: TransferJob[]) => void,
  reset: () => void,
): Promise<void> {
  transferListener ??= (async () => {
    await onTransfersChanged(apply);
    await onTransfersReset(reset);
    const jobs = await listTransfers();
    apply(jobs);
    const paused = jobs.filter((j) => j.status === "paused").length;
    if (paused > 0) {
      toast(`${paused} transfer${paused === 1 ? "" : "s"} paused`, {
        action: {
          label: "Resume all",
          onClick: () => void resumeAllTransfers(),
        },
      });
    }
  })().catch((e) => {
    // Never blocks connecting; the next call tries again.
    transferListener = null;
    console.warn("transfers: could not load the queue", e);
  });
  return transferListener;
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
  transfers: TransferJob[];
  transferScanning: boolean;
  clipboard: {
    paths: string[];
    sourceId: string;
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
  disconnectPane: (paneId: string) => void;
  setPaneSizes: (splitId: string, sizes: number[]) => void;
  /** Upserts jobs from the transfer manager, by id. */
  applyTransferChanges: (jobs: TransferJob[]) => void;
  setTransferScanning: (scanning: boolean) => void;
  clearCompletedTransfers: () => Promise<void>;
  setClipboard: (
    sourceId: string,
    paths: string[],
    mode: "copy" | "cut",
    sourceDirect?: { host?: string; port?: number; username?: string },
  ) => void;
  clearClipboard: () => void;
  requestRefresh: (paneId: string) => void;
  setError: (error: string | null, type: SftpErrorState["errorType"]) => void;
  clearError: () => void;
  ensureTransferListener: () => Promise<void>;
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
  transferScanning: false,
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

  disconnectPane: (paneId) => {
    const root = get().root;
    if (!root) return;
    const leaf = findLeafUtil(root, paneId);
    if (!leaf) return;
    set({
      root: replaceNode(root, paneId, {
        ...leaf,
        connectionType: null,
        hostId: undefined,
        hostName: undefined,
        hostAddress: undefined,
        hostPort: undefined,
        hostUsername: undefined,
        localPath: undefined,
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

  applyTransferChanges: (jobs) =>
    set((s) => {
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const kept = s.transfers.map((t) => byId.get(t.id) ?? t);
      const known = new Set(s.transfers.map((t) => t.id));
      return { transfers: [...kept, ...jobs.filter((j) => !known.has(j.id))] };
    }),
  setTransferScanning: (scanning) => set({ transferScanning: scanning }),
  clearCompletedTransfers: async () => {
    await clearFinishedTransfers();
    set((s) => ({
      transfers: s.transfers.filter(
        (t) => t.status !== "done" && t.status !== "cancelled",
      ),
    }));
  },
  setClipboard: (sourceId, paths, mode, sourceDirect) =>
    set({ clipboard: { paths, sourceId, sourceDirect }, clipboardMode: mode }),
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
  ensureTransferListener: () =>
    startTransferListener(get().applyTransferChanges, () =>
      set({ transfers: [] }),
    ),

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
      await get().ensureTransferListener();
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
      await get().ensureTransferListener();
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
    set({ sftpConnection: { ...initialConnectionState } });
  },
}));
