import { useFileItemDnD } from "@/hooks/sftp/useFileItemDnD";
import { formatDate, formatSize, getFileIcon } from "@/lib/sftp/fileHelpers";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface FileGridItemProps {
  file: FileItem;
  paneId: string;
  hostId: string;
  selectedFiles: Set<string>;
  allFiles: FileItem[];
  renamingPath: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  sourceDirect?: { host?: string; port?: number; username?: string };
  onSelect: (
    fileName: string,
    isMultiSelect: boolean,
    isRangeSelect: boolean,
  ) => void;
  onDoubleClick: (file: FileItem) => void;
  onContextMenu: (e: React.MouseEvent, file: FileItem) => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onSetRenamingPath: (path: string | null) => void;
}

export default function FileGridItem({
  file,
  paneId,
  hostId,
  selectedFiles,
  allFiles,
  renamingPath,
  renameValue,
  renameInputRef,
  sourceDirect,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onRenameValueChange,
  onCommitRename,
  onSetRenamingPath,
}: FileGridItemProps) {
  const { droppable, mergedRef } = useFileItemDnD({
    paneId,
    file,
    hostId,
    selectedFiles,
    files: allFiles,
    sourceDirect,
  });

  const isSelected = selectedFiles.has(file.name);
  const isDropTarget = droppable.isDropTarget;
  const ext =
    file.type !== "directory" && file.name.includes(".")
      ? file.name.split(".").pop()?.toUpperCase()
      : undefined;

  const stateClasses = isDropTarget
    ? "bg-primary-600/15 border-primary-500/50 scale-[1.02]"
    : isSelected
      ? "bg-primary-600/15 border-primary-500/40"
      : "bg-dark-800/60 border-transparent hover:bg-dark-700/80 hover:border-dark-600/60";

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: file card is interactive */}
      <div
        ref={mergedRef}
        data-file-item
        data-file-name={file.name}
        data-drop-target-path={file.path}
        data-drop-target-pane={paneId}
        data-drop-target-host={hostId}
        data-drop-target-type={file.type}
        onDoubleClick={() => onDoubleClick(file)}
        onClick={(e) => onSelect(file.name, e.ctrlKey || e.metaKey, e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            if ((e.target as HTMLElement).tagName === "INPUT") return;
            e.preventDefault();
            onSelect(file.name, e.ctrlKey || e.metaKey, e.shiftKey);
          }
        }}
        onContextMenu={(e) => onContextMenu(e, file)}
        className={`group relative p-3 rounded-2xl cursor-pointer select-none flex flex-col items-center border ${stateClasses}`}
      >
        {isSelected && !isDropTarget && (
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary-500" />
        )}
        <div className="flex items-center justify-center">
          {getFileIcon(file, 56)}
        </div>
        {renamingPath === file.path ? (
          <input
            ref={renameInputRef}
            aria-label="Rename file"
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename();
              if (e.key === "Escape") onSetRenamingPath(null);
              if (e.key === " ") e.stopPropagation();
            }}
            onBlur={onCommitRename}
            onClick={(e) => e.stopPropagation()}
            className="mt-3 w-full bg-dark-900 border border-primary-500 rounded px-1.5 py-0.5 text-xs text-white text-center focus:outline-none focus:ring-1 focus:ring-primary-500/40"
          />
        ) : (
          <div className="mt-3 w-full text-center">
            <div
              className="text-white text-xs font-medium truncate leading-tight"
              title={file.name}
            >
              {file.name}
            </div>
            <div className="flex items-center justify-center gap-1.5 mt-1.5">
              {ext ? (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-dark-700 text-dark-300">
                  {ext}
                </span>
              ) : (
                <span className="text-dark-500 text-[10px]">Folder</span>
              )}
              <span className="text-dark-500 text-[10px]">
                {file.type === "directory" ? "" : formatSize(file.size)}
              </span>
            </div>
            {file.modifiedAt && (
              <div className="text-dark-500 text-[10px] mt-1">
                {formatDate(file.modifiedAt)}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
