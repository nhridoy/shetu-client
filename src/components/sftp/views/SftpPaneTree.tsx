import { useRef } from "react";
import { SplitDivider } from "@/components/common/SplitDivider";
import SftpPane from "@/components/sftp/views/SftpPane";
import {
  computeLayout,
  countLeaves,
  type PlacedDivider,
  type PlacedPane,
} from "@/lib/common/paneLayout";
import {
  findLeaf,
  type SftpPaneNode,
  useSftpStore,
} from "@/stores/sftp/sftpStore";

type DropSide = "left" | "right" | "top" | "bottom";

interface SftpPaneTreeProps {
  node: SftpPaneNode;
  activePaneId: string | null;
  dropTarget: { paneId: string; side: DropSide } | null;
}

export default function SftpPaneTree({
  node,
  activePaneId,
  dropTarget,
}: SftpPaneTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const connectHost = useSftpStore((s) => s.connectHost);
  const setPaneSizes = useSftpStore((s) => s.setPaneSizes);
  const setFocusedPane = useSftpStore((s) => s.setFocusedPane);
  const focusedPaneId = useSftpStore((s) => s.focusedPaneId);
  const closable = countLeaves(node) > 2;
  const draggable = countLeaves(node) > 1;
  const canFocus = countLeaves(node) > 1;
  const hasFocus = canFocus && focusedPaneId !== null;

  const panes: PlacedPane[] = [];
  const dividers: PlacedDivider[] = [];
  computeLayout(node, 0, 0, 100, 100, panes, dividers);

  const findSplit = (splitId: string) => {
    const root = useSftpStore.getState().root;
    if (!root) return null;
    const stack: SftpPaneNode[] = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (n.type === "split" && n.id === splitId) return n;
      if (n.type === "split") stack.push(...n.children);
    }
    return null;
  };

  return (
    <div ref={containerRef} className="absolute inset-0">
      {panes.map((p) => {
        const leaf = findLeaf(node, p.id);
        if (!leaf) return null;
        const isFocusedPane = hasFocus && p.id === focusedPaneId;
        return (
          <div
            key={p.id}
            className={`absolute overflow-hidden ${
              hasFocus && !isFocusedPane ? "hidden" : ""
            }`}
            style={
              isFocusedPane
                ? { left: 0, top: 0, width: "100%", height: "100%" }
                : {
                    left: `${p.left}%`,
                    top: `${p.top}%`,
                    width: `${p.width}%`,
                    height: `${p.height}%`,
                  }
            }
          >
            <SftpPane
              pane={leaf}
              isActive={p.id === activePaneId}
              closable={closable}
              draggable={draggable}
              dropSide={dropTarget?.paneId === p.id ? dropTarget.side : null}
              canFocus={canFocus}
              isFocused={isFocusedPane}
              onToggleFocus={() =>
                setFocusedPane(isFocusedPane ? null : leaf.id)
              }
              onConnectHost={(host) =>
                connectHost(
                  leaf.id,
                  host.id,
                  host.name,
                  host.address,
                  host.port ?? undefined,
                  host.username,
                )
              }
            />
          </div>
        );
      })}

      {hasFocus
        ? null
        : dividers.map((d) => (
            <SplitDivider
              key={d.id}
              divider={d}
              containerRef={containerRef}
              onResize={(splitId, sizes) => setPaneSizes(splitId, sizes)}
              findSplit={findSplit}
            />
          ))}
    </div>
  );
}
