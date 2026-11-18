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
import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import { findLeaf, useSftpStore } from "@/stores/sftp/sftpStore";

/** A pane as a comparison side: its provider and the folder it shows. */
export function sideOf(paneId: string): CompareSide | null {
  const root = useSftpStore.getState().root;
  const leaf = root ? findLeaf(root, paneId) : null;
  const path = useFileBrowserStore.getState().panes[paneId]?.currentPath;
  if (leaf?.type !== "leaf" || !path) return null;
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

export function useFolderCompare(leftPaneId: string, rightPaneId: string) {
  const [rows, setRows] = useState<CompareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const sides = useRef<[CompareSide, CompareSide] | null>(null);

  const rescan = useCallback(async () => {
    const left = sideOf(leftPaneId);
    const right = sideOf(rightPaneId);
    if (!left || !right) {
      setError("Both panes must be open to compare");
      return;
    }
    sides.current = [left, right];
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadComparison(left, right);
      if (mine === generation.current) setRows(next);
    } catch (e) {
      if (mine === generation.current) {
        setRows([]);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [leftPaneId, rightPaneId]);

  /** Drops the scan in flight: its result is ignored. */
  const cancel = useCallback(() => {
    generation.current++;
    setLoading(false);
  }, []);

  const copy = useCallback(
    async (picked: CompareRow[], direction: Direction) => {
      if (!sides.current) return;
      const [left, right] = sides.current;
      const results = await copyRows(picked, direction, left, right);
      const failed = results.filter((r) => r.error).length;
      const waiting = results.filter((r) => r.action === "waiting").length;
      const copied = results.length - failed - waiting;
      if (failed > 0) toast.warning(`Copied ${copied} files, ${failed} failed`);
      else if (waiting > 0) toast(`Copied ${copied} files, ${waiting} waiting`);
      else if (copied > 0) toast.success(`Copied ${copied} files`);
      await rescan();
    },
    [rescan],
  );

  const remove = useCallback(
    async (row: CompareRow) => {
      if (!sides.current) return;
      const [left, right] = sides.current;
      const side = row.status === "onlyLeft" ? left : right;
      await deleteEntry(side, row.path);
      await rescan();
    },
    [rescan],
  );

  useEffect(() => {
    void rescan();
  }, [rescan]);

  return { rows, loading, error, rescan, cancel, copy, remove };
}
