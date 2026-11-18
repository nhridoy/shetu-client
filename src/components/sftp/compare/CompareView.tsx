import {
  ArrowLeftIcon,
  ArrowRightIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useFolderCompare } from "@/hooks/sftp/useFolderCompare";
import type { CompareEntry, CompareRow } from "@/lib/sftp/compareFolders";
import { copyable } from "@/lib/sftp/folderCompare";
import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import { findLeaf, useSftpStore } from "@/stores/sftp/sftpStore";

const BADGE: Record<CompareRow["status"], string> = {
  onlyLeft: "+",
  onlyRight: "−",
  differs: "≠",
  same: "=",
  conflict: "!",
};

function paneLabel(paneId: string): string {
  const root = useSftpStore.getState().root;
  const leaf = root ? findLeaf(root, paneId) : null;
  const path = useFileBrowserStore.getState().panes[paneId]?.currentPath ?? "";
  const name =
    leaf?.type === "leaf" && leaf.connectionType === "host"
      ? (leaf.hostName ?? "Host")
      : "Local";
  return `${name}: ${path}`;
}

function describe(e?: CompareEntry): string {
  if (!e) return "—";
  if (e.isDir) return "folder";
  const size =
    e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`;
  return `${size} · ${new Date(e.mtime * 1000).toLocaleString()}`;
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

export default function CompareView({
  leftPaneId,
  rightPaneId,
  onClose,
}: {
  leftPaneId: string;
  rightPaneId: string;
  onClose: () => void;
}) {
  const { rows, loading, error, rescan, cancel, copy, remove } =
    useFolderCompare(leftPaneId, rightPaneId);
  const [showSame, setShowSame] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sameCount = rows.filter((r) => r.status === "same").length;
  const visible = useMemo(
    () => rows.filter((r) => showSame || r.status !== "same"),
    [rows, showSame],
  );
  const picked = rows.filter((r) => selected.has(r.path));

  const confirmDelete = (row: CompareRow) => {
    const where =
      row.status === "onlyLeft"
        ? paneLabel(leftPaneId)
        : paneLabel(rightPaneId);
    if (window.confirm(`Delete ${row.path} from ${where}?`)) void remove(row);
  };
  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-dark-900 text-xs">
      <div className="flex items-center gap-2 border-b border-dark-700 px-3 py-2">
        <span className="flex-1 truncate text-dark-300">
          {paneLabel(leftPaneId)} ⟷ {paneLabel(rightPaneId)}
        </span>
        {picked.length > 0 && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(picked, "right")}
            >
              Copy selected →
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(picked, "left")}
            >
              ← Copy selected
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => void copy(rows, "right")}>
          Sync →
        </Button>
        <Button size="sm" onClick={() => void copy(rows, "left")}>
          ← Sync
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSame((v) => !v)}
        >
          {showSame ? "Hide identical" : `Show identical (${sameCount})`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void rescan()}>
          Rescan
        </Button>
        <IconButton label="Close" onClick={onClose}>
          <XIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {loading && (
        <div className="flex items-center gap-2 px-3 py-2 text-dark-400">
          Comparing…
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}
      {error && <div className="px-3 py-2 text-red-400">{error}</div>}
      {!loading && !error && visible.length === 0 && (
        <div className="px-3 py-2 text-dark-400">No differences.</div>
      )}
      <div className="flex-1 overflow-y-auto">
        {visible.map((row) => {
          const right = copyable([row], "right").length > 0;
          const left = copyable([row], "left").length > 0;
          const targetOnly =
            row.status === "onlyLeft" || row.status === "onlyRight";
          return (
            <div
              key={row.path}
              data-compare-row={row.path}
              className="flex items-center gap-2 border-b border-dark-800 px-3 py-1.5"
            >
              <input
                type="checkbox"
                aria-label={`Select ${row.path}`}
                checked={selected.has(row.path)}
                disabled={row.status === "conflict" || row.status === "same"}
                onChange={() => toggle(row.path)}
              />
              <span className="w-4 text-center text-dark-400">
                {BADGE[row.status]}
              </span>
              <span className="flex-1 truncate text-white">{row.path}</span>
              <span className="w-48 truncate text-dark-500">
                {describe(row.left)}
              </span>
              <span className="w-48 truncate text-dark-500">
                {describe(row.right)}
              </span>
              {row.status === "conflict" && (
                <span className="text-yellow-400">different types</span>
              )}
              {right && (
                <IconButton
                  label="Copy to right"
                  onClick={() => void copy([row], "right")}
                >
                  <ArrowRightIcon className="h-3 w-3" />
                </IconButton>
              )}
              {left && (
                <IconButton
                  label="Copy to left"
                  onClick={() => void copy([row], "left")}
                >
                  <ArrowLeftIcon className="h-3 w-3" />
                </IconButton>
              )}
              {targetOnly && (
                <IconButton label="Delete" onClick={() => confirmDelete(row)}>
                  <TrashIcon className="h-3 w-3 text-red-400" />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
