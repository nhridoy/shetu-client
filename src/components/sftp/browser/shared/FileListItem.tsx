import { useFileItemDnD } from "@/hooks/sftp/useFileItemDnD";
import { formatDate, formatSize, getFileIcon } from "@/lib/sftp/fileHelpers";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface FileListItemProps {
  file: FileItem;
  paneId: string;
  hostId: string;
  selectedFiles: Set<string>;
  allFiles: FileItem[];
  renamingPath: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  sourceDirect?: { host?: string; port?: number; username?: string };
  showPermissions?: boolean;
  columnWidths?: Record<string, number>;
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

export default function FileListItem({
  file,
  paneId,
  hostId,
  selectedFiles,
  allFiles,
  renamingPath,
  renameValue,
  renameInputRef,
  sourceDirect,
  showPermissions = false,
  columnWidths,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onRenameValueChange,
  onCommitRename,
  onSetRenamingPath,
}: FileListItemProps) {
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

  const rowBg = isDropTarget
    ? "bg-primary-600/20"
    : isSelected
      ? "bg-primary-600/15"
      : "group-hover:bg-dark-700/60";

  const accent = isSelected || isDropTarget;

  return (
    <tr
      ref={mergedRef}
      data-file-item
      data-file-name={file.name}
      data-drop-target-path={file.path}
      data-drop-target-pane={paneId}
      data-drop-target-host={hostId}
      data-drop-target-type={file.type}
      data-file-row
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
      className="group cursor-pointer select-none"
    >
      <td
        className={`relative p-2 rounded-l-lg ${rowBg}`}
        style={columnWidths ? { width: columnWidths.icon } : undefined}
      >
        {accent && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded bg-primary-500" />
        )}
        {getFileIcon(file)}
      </td>
      <td
        className={`p-2 text-sm overflow-hidden ${rowBg} ${
          isSelected ? "text-white" : "text-dark-100"
        }`}
        title={file.name}
        style={columnWidths ? { width: columnWidths.name } : undefined}
      >
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
            className="bg-dark-900 border border-primary-500 rounded px-1.5 py-0.5 text-sm text-white w-full focus:outline-none focus:ring-1 focus:ring-primary-500/40"
          />
        ) : (
          <span className="block truncate font-medium">{file.name}</span>
        )}
      </td>
      <td
        className={`p-2 text-sm text-dark-300 tabular-nums ${rowBg}`}
        style={columnWidths ? { width: columnWidths.size } : undefined}
      >
        {file.type === "directory" ? "—" : formatSize(file.size)}
      </td>
      {showPermissions && (
        <td
          className={`p-2 text-dark-400 font-mono text-xs ${rowBg}`}
          style={columnWidths ? { width: columnWidths.permissions } : undefined}
        >
          {file.permissions}
        </td>
      )}
      <td
        className={`p-2 text-sm text-dark-300 tabular-nums rounded-r-lg ${rowBg}`}
        style={columnWidths ? { width: columnWidths.modified } : undefined}
      >
        {formatDate(file.modifiedAt)}
      </td>
    </tr>
  );
}
