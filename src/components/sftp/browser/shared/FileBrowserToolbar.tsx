import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  GridFourIcon,
  HouseIcon,
  ListDashesIcon,
  MagnifyingGlassIcon,
  SignOutIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { FileViewMode } from "@/types/sftp/sftpTypes";

export interface FileBrowserToolbarProps {
  currentPath: string;
  searchQuery: string;
  showHidden: boolean;
  viewMode: FileViewMode;
  pathLabel?: string;
  onNavigateTo: (path: string) => void;
  onNavigateRoot: () => void;
  onNavigateUp: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onSearchChange: (value: string) => void;
  onShowHiddenChange: (checked: boolean) => void;
  onViewModeChange: (mode: FileViewMode) => void;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  showBackForward?: boolean;
  beforeActions?: React.ReactNode;
  pathInput?: string;
  onPathInputChange?: (value: string) => void;
  onPathInputKeyDown?: (e: React.KeyboardEvent) => void;
  onPathInputBlur?: () => void;
  recursiveSearch?: boolean;
  onRecursiveSearchChange?: (checked: boolean) => void;
  onDisconnect?: () => void;
}

export default function FileBrowserToolbar({
  currentPath,
  searchQuery,
  showHidden,
  viewMode,
  pathLabel = "Path",
  onNavigateTo,
  onNavigateRoot,
  onNavigateUp,
  onRefresh,
  onNewFolder,
  onSearchChange,
  onShowHiddenChange,
  onViewModeChange,
  onNavigateBack,
  onNavigateForward,
  canNavigateBack = false,
  canNavigateForward = false,
  showBackForward = false,
  beforeActions,
  pathInput: pathInputProp,
  onPathInputChange,
  onPathInputKeyDown,
  onPathInputBlur,
  recursiveSearch = false,
  onRecursiveSearchChange,
  onDisconnect,
}: FileBrowserToolbarProps) {
  const [internalPathInput, setInternalPathInput] = useState(currentPath);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const pathInput = pathInputProp ?? internalPathInput;
  const setPathInput = onPathInputChange ?? setInternalPathInput;

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (onPathInputKeyDown) {
      onPathInputKeyDown(e);
      return;
    }
    if (e.key === "Enter") {
      onNavigateTo(pathInput);
      setIsEditingPath(false);
    } else if (e.key === "Escape") {
      setPathInput(currentPath);
      setIsEditingPath(false);
    }
  };

  const pathSegments = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-dark-700">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onNavigateRoot}
        title="Home"
      >
        <HouseIcon className="w-3.5 h-3.5 text-dark-400" weight="bold" />
      </Button>
      {showBackForward && onNavigateBack && onNavigateForward && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onNavigateBack}
            disabled={!canNavigateBack}
            title="Back"
          >
            <ArrowLeftIcon
              className="w-3.5 h-3.5 text-dark-400"
              weight="bold"
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onNavigateForward}
            disabled={!canNavigateForward}
            title="Forward"
          >
            <ArrowRightIcon
              className="w-3.5 h-3.5 text-dark-400"
              weight="bold"
            />
          </Button>
        </>
      )}
      <Button variant="ghost" size="icon-xs" onClick={onNavigateUp} title="Up">
        <ArrowUpIcon className="w-3.5 h-3.5 text-dark-400" weight="bold" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRefresh}
        title="Refresh"
      >
        <ArrowsClockwiseIcon
          className="w-3.5 h-3.5 text-dark-400"
          weight="bold"
        />
      </Button>

      {isEditingPath ? (
        <input
          ref={(el) => el?.focus()}
          aria-label={pathLabel}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={handlePathKeyDown}
          onBlur={() => {
            onPathInputBlur?.();
            setIsEditingPath(false);
          }}
          className="flex-1 min-w-0 bg-dark-800 border border-dark-600 rounded-lg px-2 py-1 text-xs text-white font-mono focus:border-primary-500 focus:outline-none"
        />
      ) : (
        <nav
          className="flex-1 min-w-0 flex items-center gap-0.5 bg-dark-800 border border-dark-600 rounded-lg px-2 py-1 text-xs font-mono overflow-x-auto"
          onDoubleClick={() => setIsEditingPath(true)}
        >
          <button
            type="button"
            onClick={() => onNavigateTo("/")}
            className="text-dark-400 hover:text-white shrink-0 px-1"
          >
            /
          </button>
          {pathSegments.map((segment, i) => {
            const segPath = `/${pathSegments.slice(0, i + 1).join("/")}`;
            const isLast = i === pathSegments.length - 1;
            return (
              <span key={segPath} className="flex items-center shrink-0">
                <span className="text-dark-600">/</span>
                <button
                  type="button"
                  onClick={() => onNavigateTo(segPath)}
                  className={`px-1 rounded hover:bg-dark-700 ${
                    isLast ? "text-white" : "text-dark-400 hover:text-white"
                  }`}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
      )}

      {beforeActions}

      <Button variant="secondary" size="sm" onClick={onNewFolder}>
        New Folder
      </Button>
      <div className="relative w-40 shrink-0">
        <MagnifyingGlassIcon
          className="w-3.5 h-3.5 text-dark-400 absolute left-2 top-1/2 -translate-y-1/2"
          weight="bold"
        />
        <input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter..."
          className="w-full bg-dark-800 border border-dark-600 rounded-lg pl-7 pr-2 py-1 text-xs text-white placeholder-dark-500 focus:border-primary-500 focus:outline-none"
        />
      </div>
      <label className="flex items-center gap-1.5 text-dark-400 text-xs cursor-pointer shrink-0">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => onShowHiddenChange(e.target.checked)}
          className="rounded bg-dark-700 border-dark-600 text-primary-500 focus:ring-primary-500"
        />
        Hidden
      </label>
      {onRecursiveSearchChange && (
        <label className="flex items-center gap-1.5 text-dark-400 text-xs cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={recursiveSearch}
            onChange={(e) => onRecursiveSearchChange(e.target.checked)}
            className="rounded bg-dark-700 border-dark-600 text-primary-500 focus:ring-primary-500"
          />
          Recursive
        </label>
      )}
      <div className="flex bg-dark-700 rounded overflow-hidden shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onViewModeChange("list")}
          className={
            viewMode === "list" ? "bg-primary-600/15 text-primary-500" : ""
          }
        >
          <ListDashesIcon className="w-3.5 h-3.5" weight="bold" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onViewModeChange("grid")}
          className={
            viewMode === "grid" ? "bg-primary-600/15 text-primary-500" : ""
          }
        >
          <GridFourIcon className="w-3.5 h-3.5" weight="bold" />
        </Button>
      </div>
      {onDisconnect && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDisconnect}
          title="Disconnect"
          className="ml-auto text-dark-400 hover:text-red-400"
        >
          <SignOutIcon className="w-3.5 h-3.5" weight="bold" />
        </Button>
      )}
    </div>
  );
}
