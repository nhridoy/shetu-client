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
  type EditConflict,
  listEdits,
  onEditConflict,
  onEditsChanged,
  type RemoteEdit,
} from "@/lib/sftp/edits";
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

let editsListener: Promise<void> | null = null;

/** Mirrors the Rust edit list and surfaces conflicts. Never blocks anything; retried later. */
function startEditsListener(
  apply: (edits: RemoteEdit[]) => void,
  conflict: (c: EditConflict | null) => void,
): Promise<void> {
  editsListener ??= (async () => {
    await onEditsChanged(apply);
    await onEditConflict(conflict);
    apply(await listEdits());
  })().catch((e) => {
    editsListener = null;
    console.warn("edits: could not load the list", e);
  });
  return editsListener;
}

let transferListener: Promise<boolean> | null = null;

/**
 * Loads the manager's queue once and mirrors its changes; offers Resume all after a restart.
 * Resolves false (and retries on the next call) when the listener couldn't start.
 */
function startTransferListener(
  apply: (jobs: TransferJob[]) => void,
  reset: () => void,
): Promise<boolean> {
  const unlisten: (() => void)[] = [];
  transferListener ??= (async () => {
    // Events that arrive while the first list loads are newer than it: replay them after.
    let pending: TransferJob[][] | null = [];
    let wipedMeanwhile = false;
    // Reset first: a wipe after any buffered update must be seen, or the update replays.
    unlisten.push(
      await onTransfersReset(() => {
        if (pending) {
          pending = [];
          wipedMeanwhile = true;
        }
        reset();
      }),
    );
    unlisten.push(
      await onTransfersChanged((jobs) => {
        if (pending) pending.push(jobs);
        else apply(jobs);
      }),
    );
    const listed = await listTransfers();
    const snapshot = wipedMeanwhile ? [] : listed;
    apply(snapshot);
    for (const batch of pending ?? []) apply(batch);
    pending = null;
    const paused = snapshot.filter((j) => j.status === "paused").length;
    if (paused > 0) {
      toast(`${paused} transfer${paused === 1 ? "" : "s"} paused`, {
        action: {
          label: "Resume all",
          onClick: () => void resumeAllTransfers(),
        },
      });
    }
    return true;
  })().catch((e) => {
    // Never blocks connecting; the next call tries again with fresh listeners.
    for (const off of unlisten) off();
    transferListener = null;
    console.warn("transfers: could not load the queue", e);
    return false;
  });
  return transferListener;
}

export interface SftpLeafNode {
  type: "leaf";
  id: string;
  connectionType: "host" | "local" | "storage" | null;
  hostId?: string;
  hostName?: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  localPath?: string;
  /** A bucket pane: the saved storage account it shows. */
  storageAccountId?: string;
  storageName?: string;
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
  /** Remote files open in a desktop app (mirror of the Rust edit list). */
  edits: RemoteEdit[];
  /** A save that found the server copy changed, waiting for the user's choice. */
  editConflict: EditConflict | null;
  applyEdits: (edits: RemoteEdit[]) => void;
  setEditConflict: (conflict: EditConflict | null) => void;
  /** Two panes being compared, or null. */
  compare: { leftPaneId: string; rightPaneId: string } | null;
  openCompare: (leftPaneId: string, rightPaneId: string) => void;
  closeCompare: () => void;
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
  connectStorage: (paneId: string, accountId: string, name: string) => void;
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
  /** True once the queue is mirrored; false if the listener couldn't start. */
  ensureTransferListener: () => Promise<boolean>;
  /** Times the queue was wiped; pending waiters treat their jobs as cancelled. */
  transferResets: number;
  resetTransfers: () => void;
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
  edits: [],
  editConflict: null,
  applyEdits: (edits) => set({ edits }),
  setEditConflict: (editConflict) => set({ editConflict }),
  compare: null,
  openCompare: (leftPaneId, rightPaneId) =>
    set({ compare: { leftPaneId, rightPaneId } }),
  closeCompare: () => set({ compare: null }),
  transferResets: 0,
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

  connectStorage: (paneId, storageAccountId, storageName) => {
    const root = get().root;
    if (!root) return;
    const leaf = findLeafUtil(root, paneId);
    if (!leaf) return;
    set({
      root: replaceNode(root, paneId, {
        ...leaf,
        connectionType: "storage",
        storageAccountId,
        storageName,
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
        storageAccountId: undefined,
        storageName: undefined,
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

  resetTransfers: () =>
    set((s) => ({ transfers: [], transferResets: s.transferResets + 1 })),
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
  ensureTransferListener: () => {
    void startEditsListener(get().applyEdits, get().setEditConflict);
    return startTransferListener(
      get().applyTransferChanges,
      get().resetTransfers,
    );
  },

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
