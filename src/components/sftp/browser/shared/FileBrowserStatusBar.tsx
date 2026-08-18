interface FileBrowserStatusBarProps {
  totalCount: number;
  selectedCount: number;
  activeTransfers?: number;
  scanning?: boolean;
}

export default function FileBrowserStatusBar({
  totalCount,
  selectedCount,
  activeTransfers,
  scanning,
}: FileBrowserStatusBarProps) {
  return (
    <div className="px-3 py-1.5 border-t border-dark-700 text-dark-400 text-xs flex justify-between">
      <span>
        {totalCount} item{totalCount !== 1 ? "s" : ""}
      </span>
      <div className="flex gap-3">
        {scanning ? (
          <span className="text-amber-400">Preparing transfer…</span>
        ) : activeTransfers ? (
          <span className="text-primary-400">
            Transferring {activeTransfers} file
            {activeTransfers !== 1 ? "s" : ""}…
          </span>
        ) : null}
        {selectedCount > 0 && <span>{selectedCount} selected</span>}
      </div>
    </div>
  );
}
