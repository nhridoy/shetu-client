import { closestCenter } from "@dnd-kit/collision";
import { useSortable } from "@dnd-kit/react/sortable";
import { FloppyDiskIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/Button";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { getWorstStatus } from "@/lib/common/connectionStatus";
import { countLeaves } from "@/lib/common/paneLayout";
import {
  computeTabSnapshot,
  type PaneNode,
  type TerminalTab,
} from "@/stores/terminal/terminalStore";

function collectPaneStatuses(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.connectionStatus];
  return node.children.flatMap(collectPaneStatuses);
}

import { StatusDot } from "@/components/ui/StatusDot";

interface SortableTabProps {
  tab: TerminalTab;
  index: number;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onSavePreset?: (tabId: string) => void;
  onSavePresetChanges?: (tabId: string) => void;
}

export default function SortableTab({
  tab,
  index,
  isActive,
  onActivate,
  onClose,
  onSavePreset,
  onSavePresetChanges,
}: SortableTabProps) {
  const { ref, isDragging } = useSortable({
    id: tab.id,
    index,
    data: { type: "tab" },
    collisionDetector: closestCenter,
  });
  const statuses = collectPaneStatuses(tab.root);
  const multiPane = countLeaves(tab.root) > 1;
  const hasPreset = !!tab.activePresetId;
  const isPresetDirty =
    hasPreset && computeTabSnapshot(tab.root) !== tab.savedPresetSnapshot;

  return (
    // biome-ignore lint/a11y/useSemanticElements: dnd-kit draggable ref requires div
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={accessibleClickHandler(onActivate)}
      className={`group relative flex h-7 items-center gap-1.5 px-2.5 text-sm rounded-md cursor-default transition-opacity duration-150 max-w-40 shrink-0 select-none ${
        isActive
          ? "bg-dark-800 text-white"
          : "text-dark-400 hover:bg-dark-800/60"
      } ${isDragging ? "opacity-40" : ""}`}
      style={{ touchAction: "none" }}
    >
      <StatusDot status={getWorstStatus(statuses)} size="xs" />
      <span className="truncate">{tab.title}</span>

      {/* Quick Preset controls */}
      {hasPreset ? (
        <>
          {isPresetDirty && (
            <span
              className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500"
              title="Unsaved changes"
            />
          )}
          {onSavePresetChanges && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                onSavePresetChanges(tab.id);
              }}
              disabled={!isPresetDirty}
              title={
                isPresetDirty ? "Save preset changes" : "No unsaved changes"
              }
              className={`shrink-0 ${
                isPresetDirty
                  ? "text-primary-400 hover:text-white"
                  : "text-dark-600 cursor-default"
              }`}
            >
              <FloppyDiskIcon className="w-3 h-3" />
            </Button>
          )}
        </>
      ) : (
        multiPane &&
        onSavePreset && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onSavePreset(tab.id);
            }}
            className="text-dark-500 hover:text-white shrink-0"
            title="Save as Quick Preset"
          >
            <FloppyDiskIcon className="w-3 h-3" />
          </Button>
        )
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={`ml-0.5 text-dark-500 hover:text-white shrink-0 focus-visible:opacity-100 ${
          isActive
            ? ""
            : "[@media(hover:hover)]:opacity-0 group-hover:opacity-100"
        }`}
        aria-label="Close tab"
        title="Close tab"
      >
        <XIcon className="w-3 h-3" />
      </Button>
    </div>
  );
}

export function TabPreview({ tab }: Readonly<{ tab: TerminalTab }>) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-800/50">
      <span className="text-xs text-dark-300 truncate max-w-40">
        {tab.title}
      </span>
    </div>
  );
}
