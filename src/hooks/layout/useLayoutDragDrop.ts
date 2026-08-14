import { move } from "@dnd-kit/helpers";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { type DropSide, useDragStore } from "@/stores/dragStore";
import { type Group, useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

export function useLayoutDragDrop({
  setActiveView,
}: {
  setActiveView: (view: string) => void;
}) {
  const { hosts, groups, updateHost, updateGroup } = useHostStore();
  const { tabs, movePane, mergeTabIntoPane } = useTerminalStore();
  const setDropPane = useDragStore((s) => s.setDropPane);
  const setSourcePane = useDragStore((s) => s.setSourcePane);

  const isDescendant = (
    groupsList: Group[],
    groupId: string,
    potentialAncestorId: string,
  ): boolean => {
    const byId = new Map(groupsList.map((g) => [g.id, g]));
    let current = byId.get(groupId);
    while (current?.parentId) {
      if (current.parentId === potentialAncestorId) return true;
      current = byId.get(current.parentId);
    }
    return false;
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { source } = event.operation;
    if (source?.data?.type === "pane-source") {
      setSourcePane({
        paneId: String(source.data.paneId),
        tabId: String(source.data.tabId),
      });
    }
    setDropPane(null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { source, target } = event.operation;
    const sourceType = source?.data?.type;

    if (sourceType === "host" && target?.data?.type === "group-target") return;
    if (sourceType === "host" && target?.data?.type === "root-target") return;
    if (sourceType === "host" && target?.data?.type === "host") return;
    if (sourceType === "group-source" && target?.data?.type === "group-target")
      return;
    if (sourceType === "group-source" && target?.data?.type === "root-target")
      return;

    if (target?.data?.type === "pane") {
      const isPaneSource = sourceType === "pane-source";
      const sameTab = isPaneSource
        ? target.data.tabId === source?.data?.tabId
        : target.data.tabId !== source?.id;
      const isSelf =
        isPaneSource && target.data.paneId === source?.data?.paneId;
      if (sameTab && !isSelf) {
        setDropPane({
          tabId: String(target.data.tabId),
          paneId: String(target.data.paneId),
          side: target.data.side as DropSide,
        });
        return;
      }
    }
    setDropPane(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { source, target } = event.operation;
    if (event.canceled || !source) {
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Host reorder (sortable)
    if (
      source.data?.type === "host" &&
      isSortable(source) &&
      source.initialIndex !== source.index
    ) {
      const reordered = move(hosts, event);
      for (const [i, h] of reordered.entries()) {
        if (h.sortOrder !== i) {
          void updateHost(h.id, { sortOrder: i });
        }
      }
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Host → group
    if (source.data?.type === "host" && target?.data?.type === "group-target") {
      updateHost(String(source.data.hostId), {
        groupId: String(target.data.groupId),
      });
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Host → root (ungroup)
    if (source.data?.type === "host" && target?.data?.type === "root-target") {
      updateHost(String(source.data.hostId), { groupId: "" });
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Group → group (nest)
    if (
      source.data?.type === "group-source" &&
      target?.data?.type === "group-target"
    ) {
      const sourceGroupId = String(source.data.groupId);
      const targetGroupId = String(target.data.groupId);
      if (
        sourceGroupId !== targetGroupId &&
        !isDescendant(groups, targetGroupId, sourceGroupId)
      ) {
        updateGroup(sourceGroupId, { parentId: targetGroupId });
      }
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Group → root (unparent)
    if (
      source.data?.type === "group-source" &&
      target?.data?.type === "root-target"
    ) {
      const sourceGroupId = String(source.data.groupId);
      const group = groups.find((g) => g.id === sourceGroupId);
      if (group?.parentId) {
        updateGroup(sourceGroupId, { parentId: "" });
      }
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Pane rearrange
    if (source.data?.type === "pane-source") {
      const sTabId = String(source.data.tabId);
      const sPaneId = String(source.data.paneId);
      if (
        target?.data?.type === "pane" &&
        target.data.tabId === sTabId &&
        target.data.paneId !== sPaneId
      ) {
        movePane(
          sTabId,
          sPaneId,
          String(target.data.paneId),
          target.data.side as DropSide,
        );
      }
      setDropPane(null);
      setSourcePane(null);
      return;
    }

    // Tab merge
    if (target?.data?.type === "pane" && target.data.tabId !== source?.id) {
      mergeTabIntoPane(
        String(source.id),
        String(target.data.tabId),
        String(target.data.paneId),
        target.data.side as DropSide,
      );
      setActiveView(String(target.data.tabId));
      setDropPane(null);
      setSourcePane(null);
    } else if (isSortable(source)) {
      // Tab reorder (sortable)
      const { initialIndex, index } = source;
      if (initialIndex !== index) {
        const reordered = move(tabs, event);
        useTerminalStore.getState().setTabOrder(reordered.map((t) => t.id));
      }
      setDropPane(null);
      setSourcePane(null);
    } else {
      setDropPane(null);
      setSourcePane(null);
    }
  };

  return {
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  };
}
