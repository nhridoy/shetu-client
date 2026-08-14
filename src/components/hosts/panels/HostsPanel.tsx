import {
  CaretRightIcon,
  DesktopTowerIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { DraggableHostCard } from "@/components/hosts/cards/DraggableHostCard";
import { DroppableGroupCard } from "@/components/hosts/cards/DroppableGroupCard";
import { BreadcrumbDropTarget } from "@/components/hosts/panels/BreadcrumbDropTarget";
import { Button } from "@/components/ui/Button";
import { EmptyActionState } from "@/components/ui/EmptyActionState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getAncestors, getChildren } from "@/lib/hosts/helpers";
import { useDragPreviewStore } from "@/stores/dragPreviewStore";
import { type Group, type Host, useHostStore } from "@/stores/hosts/hostStore";

interface HostsPanelProps {
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onNewGroup: (parentId?: string) => void;
  onNewHost: (groupId?: string) => void;
  onEditGroup: (group: Group) => void;
  onEditHost: (host: Host) => void;
  onConnect: (host: Host) => void;
  onDeleteGroup: (id: string) => void;
  onDeleteHost: (id: string) => void;
}

export default function HostsPanel({
  selectedGroupId,
  onSelectGroup,
  onNewGroup,
  onNewHost,
  onEditGroup,
  onEditHost,
  onConnect,
  onDeleteGroup,
  onDeleteHost,
}: HostsPanelProps) {
  const { hosts, groups } = useHostStore();
  const { previewHosts, isDragging } = useDragPreviewStore();

  const selectedGroup = selectedGroupId
    ? groups.find((g) => g.id === selectedGroupId)
    : null;
  const displayGroups = selectedGroupId
    ? getChildren(groups, selectedGroupId)
    : groups.filter((g) => !g.parentId);
  const displayHosts =
    isDragging && previewHosts
      ? selectedGroupId
        ? previewHosts.filter((h) => h.groupId === selectedGroupId)
        : previewHosts
      : selectedGroupId
        ? hosts.filter((h) => h.groupId === selectedGroupId)
        : hosts;

  return (
    <div className="flex-1 p-4 space-y-6 overflow-y-auto">
      {/* Breadcrumb — only in group detail */}
      {selectedGroup &&
        selectedGroupId &&
        (() => {
          const ancestors = getAncestors(groups, selectedGroupId);
          return (
            <div className="flex items-center gap-1.5 flex-wrap">
              <BreadcrumbDropTarget
                groupId={null}
                onClick={() => onSelectGroup(null)}
              >
                All Groups
              </BreadcrumbDropTarget>
              {ancestors.map((a) => (
                <span key={a.id} className="flex items-center gap-1.5">
                  <CaretRightIcon
                    className="w-3.5 h-3.5 text-dark-500"
                    weight="bold"
                  />
                  <BreadcrumbDropTarget
                    groupId={a.id}
                    onClick={() => onSelectGroup(a.id)}
                  >
                    {a.name}
                  </BreadcrumbDropTarget>
                </span>
              ))}
              <CaretRightIcon
                className="w-3.5 h-3.5 text-dark-500"
                weight="bold"
              />
              <span className="px-2.5 py-1 text-xs font-medium rounded-md bg-primary-600/20 text-primary-400">
                {selectedGroup.name}
              </span>
            </div>
          );
        })()}

      {/* Groups Section */}
      <div>
        <SectionHeader
          title="Groups"
          level="h3"
          className="text-sm tracking-wider uppercase text-dark-400 mb-3"
        >
          <Button
            type="button"
            onClick={() => onNewGroup(selectedGroupId ?? undefined)}
            variant="secondary"
            size="sm"
          >
            <PlusIcon className="w-3 h-3" weight="bold" />
            New Group
          </Button>
        </SectionHeader>
        {displayGroups.length === 0 ? (
          <EmptyActionState
            message="No groups yet — click to create one"
            onClick={() => onNewGroup(selectedGroupId ?? undefined)}
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {displayGroups.map((group) => (
              <DroppableGroupCard
                key={group.id}
                group={group}
                hostCount={hosts.filter((h) => h.groupId === group.id).length}
                childCount={getChildren(groups, group.id).length}
                onClick={() => onSelectGroup(group.id)}
                onEdit={onEditGroup}
                onDelete={onDeleteGroup}
              />
            ))}
          </div>
        )}
      </div>

      {/* Hosts Section */}
      <div>
        <SectionHeader
          title={`Hosts${selectedGroupId ? ` (${displayHosts.length})` : ""}`}
          level="h3"
          className="text-sm tracking-wider uppercase text-dark-400 mb-3"
        >
          <Button
            type="button"
            onClick={() => onNewHost(selectedGroupId ?? undefined)}
            variant="default"
            size="sm"
          >
            <PlusIcon className="w-3 h-3" weight="bold" />
            New Host
          </Button>
        </SectionHeader>
        {displayHosts.length === 0 ? (
          <EmptyActionState
            icon={DesktopTowerIcon}
            message="No hosts yet — click to add one"
            onClick={() => onNewHost(selectedGroupId ?? undefined)}
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {displayHosts.map((host, index) => (
              <DraggableHostCard
                key={host.id}
                host={host}
                index={index}
                onConnect={onConnect}
                onEdit={onEditHost}
                onDelete={onDeleteHost}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
