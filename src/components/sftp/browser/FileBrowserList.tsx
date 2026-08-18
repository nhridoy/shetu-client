import { FolderIcon } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { buildContextMenuItems } from "@/components/sftp/browser/shared/buildContextMenuItems";
import FileBrowserListShared from "@/components/sftp/browser/shared/FileBrowserList";
import FileGridItem from "@/components/sftp/browser/shared/FileGridItem";
import FileListItem from "@/components/sftp/browser/shared/FileListItem";
import ContextMenu from "@/components/ui/ContextMenu";
import {
  type ColumnDef,
  useResizableColumns,
} from "@/hooks/sftp/useResizableColumns";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type {
  FileItem,
  FileSortDirection,
  FileSortField,
  FileViewMode,
} from "@/types/sftp/sftpTypes";

const REMOTE_COLUMNS: ColumnDef[] = [
  { key: "type", label: "", defaultWidth: 36, minWidth: 36 },
  { key: "name", label: "Name", defaultWidth: 350, minWidth: 120 },
  { key: "size", label: "Size", defaultWidth: 80, minWidth: 60 },
  { key: "permissions", label: "Perms", defaultWidth: 80, minWidth: 60 },
  { key: "modifiedAt", label: "Modified", defaultWidth: 140, minWidth: 80 },
  { key: "accessedAt", label: "Accessed", defaultWidth: 140, minWidth: 80 },
];

export interface FileBrowserActions {
  handleDoubleClick: (file: FileItem) => void;
  handleSelect: (
    fileName: string,
    isMultiSelect: boolean,
    isShift?: boolean,
    allFiles?: FileItem[],
  ) => void;
  handleCopy: () => void;
  handleCut: () => void;
  handlePaste: () => void;
  handleDelete: (file: FileItem) => void;
  handleDeleteSelected?: () => void;
  handleNewFolder: () => void;
  handleNewFile: () => void;
  handleDownload: (file: FileItem) => void;
  onPermissions?: (file: FileItem) => void;
}

interface FileBrowserListProps {
  isLoading: boolean;
  sortedFiles: FileItem[];
  viewMode: FileViewMode;
  searchQuery: string;
  sortField: FileSortField;
  sortDirection: FileSortDirection;
  setSortField: (field: FileSortField) => void;
  setSortDirection: React.Dispatch<React.SetStateAction<FileSortDirection>>;
  paneId: string;
  hostId: string;
  hostAddress?: string;
  hostUsername?: string;
  selectedFiles: Set<string>;
  clipboard: { paths: string[] } | null;
  renamingPath: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  commitRename: () => void;
  setRenamingPath: (path: string | null) => void;
  setRenameValue: (value: string) => void;
  actions: FileBrowserActions;
}

export default function FileBrowserList({
  isLoading,
  sortedFiles,
  viewMode,
  searchQuery,
  sortField,
  sortDirection,
  setSortField,
  setSortDirection,
  paneId,
  hostId,
  hostAddress,
  hostUsername,
  selectedFiles,
  clipboard,
  renamingPath,
  renameValue,
  renameInputRef,
  commitRename,
  setRenamingPath,
  setRenameValue,
  actions,
}: FileBrowserListProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileItem | null;
  } | null>(null);

  const { widths: columnWidths, handleMouseDown } = useResizableColumns(
    REMOTE_COLUMNS,
    "remote",
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: FileItem | null = null) => {
      e.preventDefault();
      e.stopPropagation();
      useSftpStore.getState().setActivePane(paneId);
      if (file) {
        if (!selectedFiles.has(file.name)) {
          actions.handleSelect(file.name, false);
        }
      }
      setContextMenu({ x: e.clientX, y: e.clientY, file });
    },
    [selectedFiles, actions, paneId],
  );

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    return buildContextMenuItems(
      contextMenu.file,
      clipboard,
      {
        handleDoubleClick: actions.handleDoubleClick,
        handleDownload: actions.handleDownload,
        onCopy: actions.handleCopy,
        onCut: actions.handleCut,
        onPaste: actions.handlePaste,
        onDelete: actions.handleDelete,
        onDeleteSelected: actions.handleDeleteSelected,
        onNewFile: actions.handleNewFile,
        onNewFolder: actions.handleNewFolder,
        onPermissions: actions.onPermissions,
      },
      (path, name) => {
        setRenamingPath(path);
        setRenameValue(name);
      },
      selectedFiles,
    );
  }, [
    contextMenu,
    clipboard,
    actions,
    setRenamingPath,
    setRenameValue,
    selectedFiles,
  ]);

  let body: ReactNode;

  if (isLoading) {
    body = (
      <div className="flex-1 p-3 space-y-1">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
          <div
            key={`skel-${n}`}
            className="flex items-center gap-3 p-2 animate-pulse"
          >
            <div className="w-5 h-5 bg-dark-700 rounded" />
            <div
              className="h-3 bg-dark-700 rounded flex-1"
              style={{ width: `${40 + Math.random() * 40}%` }}
            />
            <div className="h-3 bg-dark-700 rounded w-16" />
          </div>
        ))}
      </div>
    );
  } else if (sortedFiles.length === 0) {
    body = (
      // biome-ignore lint/a11y/useSemanticElements: empty state click handler needs div
      <div
        role="button"
        tabIndex={0}
        className="flex-1 flex flex-col items-center justify-center text-dark-400"
        onContextMenu={(e) => handleContextMenu(e)}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu") {
            handleContextMenu(e as unknown as React.MouseEvent);
          }
        }}
      >
        <FolderIcon className="w-16 h-16 mb-3 text-dark-600" />
        <p>{searchQuery ? "No matching files" : "Empty directory"}</p>
      </div>
    );
  } else {
    const renderListItem = (file: FileItem) => {
      const isDirect =
        !!(hostAddress && hostUsername) &&
        file.path?.includes(`${hostUsername}@${hostAddress}`);

      return (
        <FileListItem
          key={file.path}
          file={file}
          paneId={paneId}
          hostId={hostId}
          sourceDirect={
            isDirect ? { host: hostAddress, username: hostUsername } : undefined
          }
          selectedFiles={selectedFiles}
          allFiles={sortedFiles}
          renamingPath={renamingPath}
          renameValue={renameValue}
          renameInputRef={renameInputRef}
          columnWidths={columnWidths}
          showPermissions
          onSelect={actions.handleSelect}
          onDoubleClick={() => actions.handleDoubleClick(file)}
          onContextMenu={handleContextMenu}
          onRenameValueChange={setRenameValue}
          onCommitRename={commitRename}
          onSetRenamingPath={setRenamingPath}
        />
      );
    };

    const renderGridItem = (file: FileItem) => {
      const isDirect =
        !!(hostAddress && hostUsername) &&
        file.path?.includes(`${hostUsername}@${hostAddress}`);

      return (
        <FileGridItem
          key={file.path}
          file={file}
          paneId={paneId}
          hostId={hostId}
          sourceDirect={
            isDirect ? { host: hostAddress, username: hostUsername } : undefined
          }
          selectedFiles={selectedFiles}
          allFiles={sortedFiles}
          renamingPath={renamingPath}
          renameValue={renameValue}
          renameInputRef={renameInputRef}
          onSelect={actions.handleSelect}
          onDoubleClick={() => actions.handleDoubleClick(file)}
          onContextMenu={handleContextMenu}
          onRenameValueChange={setRenameValue}
          onCommitRename={commitRename}
          onSetRenamingPath={setRenamingPath}
        />
      );
    };

    body = (
      <>
        {/* biome-ignore lint/a11y/useSemanticElements: file list click handler needs div */}
        <div
          role="button"
          tabIndex={0}
          className="flex-1 overflow-y-auto"
          onContextMenu={(e) => handleContextMenu(e)}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu") {
              handleContextMenu(e as unknown as React.MouseEvent);
            }
          }}
        >
          <FileBrowserListShared
            files={sortedFiles}
            viewMode={viewMode}
            columns={REMOTE_COLUMNS}
            columnWidths={columnWidths}
            handleColumnMouseDown={handleMouseDown}
            sortField={sortField}
            sortDirection={sortDirection}
            setSortField={setSortField}
            setSortDirection={setSortDirection}
            renderListItem={renderListItem}
            renderGridItem={renderGridItem}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {body}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
