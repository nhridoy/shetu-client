import { ArrowsLeftRightIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/Button";

interface DragOverOverlayProps {
  isDragOver: boolean;
  fileDragState: { isDragging?: boolean; sourceHostId?: string | null } | null;
}

export function DragOverOverlay({
  isDragOver,
  fileDragState,
}: DragOverOverlayProps) {
  if (!isDragOver || fileDragState) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: drop overlay needs div
    <div
      role="region"
      aria-label="Drop files to upload"
      className="absolute inset-0 z-50 bg-primary-600/20 border-2 border-dashed border-primary-500 rounded-lg flex items-center justify-center"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div className="text-center">
        <ArrowUpIcon className="w-12 h-12 mx-auto text-primary-400 mb-2" />
        <p className="text-primary-300 text-lg font-medium">
          Drop files to upload
        </p>
      </div>
    </div>
  );
}

interface DropTargetOverlayProps {
  isDropTarget: boolean;
  fileDragState: { isDragging?: boolean; sourceHostId?: string | null } | null;
  hostId: string;
  dropMode?: "move" | "copy";
}

export function DropTargetOverlay({
  isDropTarget,
  fileDragState,
  hostId,
  dropMode,
}: DropTargetOverlayProps) {
  if (!isDropTarget || !fileDragState) return null;

  const isCrossHost = dropMode
    ? dropMode === "copy"
    : fileDragState.sourceHostId
      ? fileDragState.sourceHostId !== hostId
      : false;

  return (
    // biome-ignore lint/a11y/useSemanticElements: drop target needs div
    <div
      role="region"
      aria-label="Drop target"
      className={`absolute inset-0 z-50 ${isCrossHost ? "bg-green-600/15 border-green-500" : "bg-primary-600/15 border-primary-500"} border-2 border-dashed rounded-lg flex items-center justify-center`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div className="text-center">
        {isCrossHost ? (
          <ArrowsLeftRightIcon className="w-12 h-12 mx-auto mb-2 text-green-400" />
        ) : (
          <ArrowUpIcon className="w-12 h-12 mx-auto mb-2 text-primary-400" />
        )}
        <p
          className={`text-lg font-medium ${isCrossHost ? "text-green-300" : "text-primary-300"}`}
        >
          {isCrossHost ? "Drop to copy between servers" : "Drop to move"}
        </p>
      </div>
    </div>
  );
}

interface ErrorBarProps {
  error: string | null;
  setError: (val: string | null) => void;
}

export function ErrorBar({ error, setError }: ErrorBarProps) {
  if (!error) return null;

  return (
    <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm flex items-center justify-between">
      <span>{error}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => setError(null)}
        className="text-red-300 hover:text-red-200"
      >
        &times;
      </Button>
    </div>
  );
}
