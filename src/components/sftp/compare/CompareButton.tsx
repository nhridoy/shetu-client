import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/Button";
import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import type { SftpPaneNode } from "@/stores/sftp/sftpStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";

export function leavesOf(
  node: SftpPaneNode | null,
): Extract<SftpPaneNode, { type: "leaf" }>[] {
  if (!node) return [];
  return node.type === "leaf" ? [node] : node.children.flatMap(leavesOf);
}

/** Compare this pane's folder with another pane's: the other one when there are two, a
 * picker when there are more. */
export default function CompareButton({ paneId }: { paneId: string }) {
  const others = useSftpStore(
    useShallow((s) =>
      leavesOf(s.root).filter((l) => l.id !== paneId && l.connectionType),
    ),
  );
  const openCompare = useSftpStore((s) => s.openCompare);
  const [picking, setPicking] = useState(false);
  if (others.length === 0) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled
        title="Open a second pane to compare"
      >
        Compare
      </Button>
    );
  }
  if (others.length === 1) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openCompare(paneId, others[0].id)}
      >
        Compare
      </Button>
    );
  }
  const label = (id: string, name?: string) =>
    `${name ?? "Local"}: ${useFileBrowserStore.getState().panes[id]?.currentPath ?? ""}`;
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" onClick={() => setPicking((v) => !v)}>
        Compare
      </Button>
      {picking && (
        <div className="absolute right-0 z-30 mt-1 min-w-56 rounded border border-dark-700 bg-dark-800 py-1 text-xs">
          <div className="px-3 py-1 text-dark-400">Compare with…</div>
          {others.map((leaf) => (
            <button
              key={leaf.id}
              type="button"
              className="block w-full px-3 py-1 text-left text-white hover:bg-dark-700"
              onClick={() => {
                setPicking(false);
                openCompare(paneId, leaf.id);
              }}
            >
              {label(
                leaf.id,
                leaf.connectionType === "host" ? leaf.hostName : undefined,
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
