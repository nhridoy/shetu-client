import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import {
  DragDropProvider,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  useDragDropManager,
} from "@dnd-kit/react";

import { useEffect, useState } from "react";
import FileTransfer from "@/components/sftp/transfer/FileTransfer";
import SftpPaneTree from "@/components/sftp/views/SftpPaneTree";
import { type FileDragState, useSftpStore } from "@/stores/sftp/sftpStore";

type Manager = ReturnType<typeof useDragDropManager>;

function refreshDroppableShapes(manager: Manager | null) {
  if (!manager) return;
  for (const droppable of manager.registry.droppables) {
    (droppable as { refreshShape?: () => void }).refreshShape?.();
  }
}

function ShapeRefresher() {
  const manager = useDragDropManager();

  useEffect(() => {
    if (!manager) return;
    return manager.monitor.addEventListener("beforedragstart", () => {
      refreshDroppableShapes(manager);
    });
  }, [manager]);

  useEffect(() => {
    if (!manager) return;
    let timer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refreshDroppableShapes(manager), 150);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timer);
    };
  }, [manager]);

  return null;
}

type DropSide = "left" | "right" | "top" | "bottom";

export default function SftpLayout() {
  const root = useSftpStore((s) => s.root);
  const activePaneId = useSftpStore((s) => s.activePaneId);
  const movePane = useSftpStore((s) => s.movePane);
  const setFileDragState = useSftpStore((s) => s.setFileDragState);
  const setPendingFileDrop = useSftpStore((s) => s.setPendingFileDrop);
  const [dropTarget, setDropTarget] = useState<{
    paneId: string;
    side: DropSide;
  } | null>(null);

  useEffect(() => {
    if (!useSftpStore.getState().root) {
      const firstId = `sftp-pane-${Date.now()}`;
      const secondId = `sftp-pane-${Date.now() + 1}`;
      const split = {
        type: "split" as const,
        id: `sftp-split-${Date.now()}`,
        direction: "horizontal" as const,
        children: [
          {
            type: "leaf" as const,
            id: firstId,
            connectionType: null,
            size: 50,
          },
          {
            type: "leaf" as const,
            id: secondId,
            connectionType: null,
            size: 50,
          },
        ],
        size: 100,
      };
      useSftpStore.setState({ root: split, activePaneId: firstId });
    }
  }, []);

  const handleDragStart = (event: DragStartEvent) => {
    const source = event.operation.source;
    if (source?.data?.type === "file-drag") {
      setFileDragState({
        isDragging: true,
        files: source.data.files as FileDragState["files"],
        sourceHostId: source.data.hostId as string,
        sourcePaneId: source.data.paneId as string,
        sourceDirect: source.data.sourceDirect as FileDragState["sourceDirect"],
      });
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { source, target } = event.operation;
    if (
      source?.data?.type === "sftp-pane-source" &&
      target?.data?.type === "sftp-pane"
    ) {
      const sourcePaneId = String(source.data.paneId);
      const targetPaneId = String(target.data.paneId);
      const side = target.data.side as DropSide;
      if (sourcePaneId !== targetPaneId) {
        setDropTarget({ paneId: targetPaneId, side });
        return;
      }
    }
    setDropTarget(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { source, target } = event.operation;

    if (event.canceled || !source) {
      setDropTarget(null);
      setFileDragState(null);
      return;
    }

    if (
      source.data?.type === "sftp-pane-source" &&
      target?.data?.type === "sftp-pane"
    ) {
      const sourcePaneId = String(source.data.paneId);
      const targetPaneId = String(target.data.paneId);
      const side = target.data.side as DropSide;
      if (sourcePaneId !== targetPaneId) {
        movePane(sourcePaneId, targetPaneId, side);
      }
    } else if (
      source.data?.type === "file-drag" &&
      target?.data?.type === "file-drop"
    ) {
      const sourceHostId = String(source.data.hostId);
      const sourcePaneId = String(source.data.paneId);
      const files = source.data.files as FileDragState["files"];
      const destHostId = String(target.data.hostId);
      const destDirPath = String(target.data.path);
      const destPaneId = String(target.data.paneId);
      const srcDir = files[0]?.path.split("/").slice(0, -1).join("/") || "/";

      // Only execute if not a no-op (same host + same dir)
      if (!(sourceHostId === destHostId && srcDir === destDirPath)) {
        setPendingFileDrop({
          files,
          sourceHostId,
          destHostId,
          destDirPath,
          paneId: destPaneId,
          destPaneId,
          sourceDirect: source.data
            .sourceDirect as FileDragState["sourceDirect"],
          sourcePaneId,
        });
      }
    }

    setDropTarget(null);
    setFileDragState(null);
  };

  return (
    <DragDropProvider
      sensors={(defaults) => [
        ...defaults.filter(
          (sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor,
        ),
        PointerSensor.configure({
          activationConstraints: (event) => {
            if (event.pointerType === "touch") {
              return [
                new PointerActivationConstraints.Delay({
                  value: 250,
                  tolerance: 5,
                }),
              ];
            }
            return [new PointerActivationConstraints.Distance({ value: 5 })];
          },
        }),
      ]}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <ShapeRefresher />
      <div className="flex-1 relative bg-dark-900 overflow-hidden">
        {root && (
          <SftpPaneTree
            node={root}
            activePaneId={activePaneId}
            dropTarget={dropTarget}
          />
        )}
      </div>

      <FileTransfer />
    </DragDropProvider>
  );
}
