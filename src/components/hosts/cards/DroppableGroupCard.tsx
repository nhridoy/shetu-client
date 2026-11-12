import { useDraggable, useDroppable } from "@dnd-kit/react";
import { FolderIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import type { Group } from "@/stores/hosts/hostStore";

export function DroppableGroupCard({
  group,
  hostCount,
  childCount,
  colors = [],
  onClick,
  onEdit,
  onDelete,
}: {
  group: Group;
  hostCount: number;
  childCount: number;
  /** Colours of the group's hosts, shown as a small dot stack. */
  colors?: string[];
  onClick: () => void;
  onEdit: (group: Group) => void;
  onDelete: (groupId: string) => void;
}) {
  const { ref: droppableRef, isDropTarget } = useDroppable({
    id: `group:${group.id}`,
    data: { type: "group-target", groupId: group.id },
  });
  const { ref: draggableRef, isDragging } = useDraggable({
    id: `group-drag:${group.id}`,
    data: { type: "group-source", groupId: group.id },
  });

  const setRefs = (el: HTMLDivElement | null) => {
    droppableRef(el);
    draggableRef(el);
  };

  const deleteDialog = useModal();

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: contains nested <button> elements for edit/delete */}
      <div
        ref={setRefs}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={accessibleClickHandler(onClick)}
        className={`relative p-3 transition-colors rounded-lg cursor-pointer group ${
          isDragging
            ? "opacity-50"
            : isDropTarget
              ? "bg-primary-600/20 ring-2 ring-primary-500"
              : "bg-dark-800/50 hover:bg-dark-800 border border-primary-500/10"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-7 h-7 rounded-full shrink-0 bg-primary-500/10 border border-primary-500/40">
            <FolderIcon
              className="w-3.5 h-3.5 text-primary-400"
              weight="bold"
            />
          </span>
          <span className="flex-1 text-sm font-medium text-white truncate">
            {group.name}
          </span>
        </div>
        <p className="flex items-center mt-1.5 text-xs text-dark-500">
          {hostCount} host{hostCount === 1 ? "" : "s"}
          {childCount > 0 &&
            ` · ${childCount} sub-group${childCount === 1 ? "" : "s"}`}
          {colors.length > 0 && (
            <span className="flex ml-auto pl-2">
              {colors.slice(0, 5).map((color, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: colours repeat
                  key={i}
                  className="w-3 h-3 -ml-1 rounded-full border-2 border-dark-900"
                  style={{ backgroundColor: color }}
                />
              ))}
            </span>
          )}
        </p>
        <div className="absolute flex items-center gap-1 transition-opacity opacity-0 top-2 right-2 group-hover:opacity-100">
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(group);
            }}
            variant="ghost"
            size="icon-xs"
            title="Edit group"
          >
            <PencilSimpleIcon className="w-3 h-3" weight="bold" />
          </Button>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteDialog.show();
            }}
            variant="ghost"
            size="icon-xs"
            className="hover:text-red-500"
            title="Delete group"
          >
            <TrashIcon className="w-3 h-3" weight="bold" />
          </Button>
        </div>
      </div>
      {/* Outside the card: a click or Enter in the dialog would also activate the card. */}
      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message={`Delete group "${group.name}"?`}
        onConfirm={() => {
          deleteDialog.hide();
          onDelete(group.id);
        }}
        onCancel={deleteDialog.hide}
      />
    </>
  );
}
