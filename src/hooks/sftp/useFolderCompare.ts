import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CompareRow } from "@/lib/sftp/compareFolders";
import { LocalFileProvider } from "@/lib/sftp/fileTransfer";
import {
  type CompareSide,
  copyRows,
  type Direction,
  deleteEntry,
  loadComparison,
} from "@/lib/sftp/folderCompare";
import { RemoteFileProviderImpl } from "@/lib/sftp/remoteFs";
import { StorageFileProvider } from "@/lib/sftp/storageFs";
import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import { findLeaf, useSftpStore } from "@/stores/sftp/sftpStore";

/** A pane as a comparison side: its provider and the folder it shows. */
export function sideOf(paneId: string): CompareSide | null {
  const root = useSftpStore.getState().root;
  const leaf = root ? findLeaf(root, paneId) : null;
  const path = useFileBrowserStore.getState().panes[paneId]?.currentPath;
  if (leaf?.type !== "leaf" || !path) return null;
  if (leaf.connectionType === "storage") {
    // A bucket pane's session id is its pane id too.
    return {
      kind: "storage",
      provider: new StorageFileProvider(
        `storage:${leaf.storageAccountId ?? ""}`,
        paneId,
      ),
      root: path,
    };
  }
  if (leaf.connectionType === "local") {
    return {
      kind: "local",
      provider: new LocalFileProvider("local"),
      root: path,
    };
  }
  // A host pane's SFTP session id is its pane id.
  return {
    kind: "remote",
    provider: new RemoteFileProviderImpl(leaf.hostId ?? "", paneId),
    root: path,
  };
}

/** What a pane is connected to; a change means the rows no longer describe it. */
function connectionOf(paneId: string): string {
  const root = useSftpStore.getState().root;
  const leaf = root ? findLeaf(root, paneId) : null;
  if (leaf?.type !== "leaf") return "";
  return [
    leaf.connectionType,
    leaf.hostId,
    leaf.storageAccountId,
    leaf.localPath,
  ].join("|");
}

export function useFolderCompare(leftPaneId: string, rightPaneId: string) {
  // A pane that reconnects elsewhere (another host or bucket) is listed again, so no row or
  // action can apply one connection's paths to another.
  const connections = useSftpStore(
    () => `${connectionOf(leftPaneId)}#${connectionOf(rightPaneId)}`,
  );
  // The rows, the folders they came from and the connections they were listed on, set
  // together: every action uses the folders of the rows it was rendered with.
  const [shown, setShown] = useState<{
    rows: CompareRow[];
    sides: [CompareSide, CompareSide] | null;
    connections: string;
  }>({ rows: [], sides: null, connections: "" });
  const current = useCallback(
    () => `${connectionOf(leftPaneId)}#${connectionOf(rightPaneId)}`,
    [leftPaneId, rightPaneId],
  );
  const { rows, sides } = shown;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const rescan = useCallback(async () => {
    const left = sideOf(leftPaneId);
    const right = sideOf(rightPaneId);
    if (!left || !right) {
      setError("Both panes must be open to compare");
      return;
    }
    const mine = ++generation.current;
    const listedOn = current();
    // Rows from another connection go at once, not when this scan finishes.
    setShown((s) =>
      s.connections === listedOn
        ? s
        : { rows: [], sides: null, connections: listedOn },
    );
    setLoading(true);
    setError(null);
    try {
      const next = await loadComparison(left, right);
      if (mine === generation.current)
        setShown({ rows: next, sides: [left, right], connections: listedOn });
    } catch (e) {
      if (mine === generation.current) {
        setShown({ rows: [], sides: null, connections: listedOn });
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [leftPaneId, rightPaneId, current]);

  /** The rows' connections are still the panes' own; an action from before a reconnect stops
   * here instead of applying one connection's paths to another. */
  const stillListed = useCallback(() => {
    if (current() === shown.connections) return true;
    toast.warning("A pane connected somewhere else; comparing again");
    return false;
  }, [current, shown.connections]);

  /** Drops the scan in flight: its result is ignored. */
  const cancel = useCallback(() => {
    generation.current++;
    setLoading(false);
  }, []);

  const copy = useCallback(
    async (picked: CompareRow[], direction: Direction) => {
      if (!sides || !stillListed()) return;
      const [left, right] = sides;
      const results = await copyRows(
        picked,
        direction,
        left,
        right,
        () => current() === shown.connections,
      );
      const failed = results.filter((r) => r.error).length;
      const waiting = results.filter((r) => r.action === "waiting").length;
      const copied = results.length - failed - waiting;
      if (failed > 0) toast.warning(`Copied ${copied} files, ${failed} failed`);
      else if (waiting > 0) toast(`Copied ${copied} files, ${waiting} waiting`);
      else if (copied > 0) toast.success(`Copied ${copied} files`);
      await rescan();
    },
    [rescan, sides, stillListed, current, shown.connections],
  );

  const remove = useCallback(
    async (row: CompareRow) => {
      if (!sides || !stillListed()) return;
      const [left, right] = sides;
      const side = row.status === "onlyLeft" ? left : right;
      await deleteEntry(side, row.path);
      await rescan();
    },
    [rescan, sides, stillListed],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a connection change rescans
  useEffect(() => {
    void rescan();
  }, [rescan, connections]);

  return { rows, sides, loading, error, rescan, cancel, copy, remove };
}
