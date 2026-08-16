import { useFileItemDnD } from "@/hooks/sftp/useFileItemDnD";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { formatDate, formatSize, getFileIcon } from "@/lib/sftp/fileHelpers";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface FileItemProps {
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
}: FileItemProps) {
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

  const ext = file.name.includes(".")
    ? file.name.split(".").pop()?.toUpperCase()
    : undefined;

  return (
    <div
      ref={mergedRef}
      role="button"
      tabIndex={0}
      data-file-item
      data-file-name={file.name}
      data-drop-target-path={file.path}
      data-drop-target-pane={paneId}
      data-drop-target-host={hostId}
      data-drop-target-type={file.type}
      data-file-row
      title={file.name}
      onKeyDown={accessibleClickHandler(() => onDoubleClick(file))}
      onDoubleClick={() => onDoubleClick(file)}
      onClick={(e) => onSelect(file.name, e.ctrlKey || e.metaKey, e.shiftKey)}
      onContextMenu={(e) => onContextMenu(e, file)}
      className={`group relative p-4 rounded-xl cursor-pointer select-none flex flex-col items-center transition-all duration-150 ${
        isDropTarget
          ? "bg-primary-600/15 ring-2 ring-inset ring-primary-500/60 scale-[1.02]"
          : isSelected
            ? "bg-primary-600/15 ring-1 ring-primary-500/40"
            : "bg-dark-800/60 hover:bg-dark-700/80 hover:ring-1 hover:ring-dark-600"
      }`}
    >
      {getFileIcon(file, 56)}

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
          className="bg-dark-900 border border-primary-500 rounded px-2 py-1 text-xs text-white w-full mt-3 text-center focus:outline-none"
        />
      ) : (
        <div className="mt-3 w-full text-center">
          <div className="text-white text-xs font-medium truncate leading-tight">
            {file.name}
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-1.5">
            {file.type !== "directory" && ext ? (
              <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-dark-700 text-dark-300">
                {ext}
              </span>
            ) : null}
            <span className="text-dark-500 text-[10px]">
              {file.type === "directory" ? "Folder" : formatSize(file.size)}
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
  );
}
