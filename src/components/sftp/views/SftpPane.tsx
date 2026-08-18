import { useDraggable } from "@dnd-kit/react";
import { DesktopTowerIcon, FolderIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/common/DropZone";
import FileBrowser from "@/components/sftp/browser/FileBrowser";
import LocalFileBrowser from "@/components/sftp/browser/LocalFileBrowser";
import SftpHostPicker from "@/components/sftp/picker/SftpHostPicker";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import PaneHeader from "@/components/ui/PaneHeader";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { extractError } from "@/lib/common/extractError";
import { type DropSide, previewStyle } from "@/lib/common/paneLayout";
import { openDirectoryPicker } from "@/lib/sftp/localFs";
import type { Host } from "@/stores/hosts/hostStore";
import { type SftpLeafNode, useSftpStore } from "@/stores/sftp/sftpStore";

interface SftpPaneProps {
  pane: SftpLeafNode;
  isActive: boolean;
  closable: boolean;
  draggable?: boolean;
  canFocus?: boolean;
  isFocused?: boolean;
  onToggleFocus?: () => void;
  dropSide: DropSide | null;
  onConnectHost: (host: Host) => void;
}

export default function SftpPane({
  pane,
  isActive,
  closable,
  draggable = false,
  canFocus = false,
  isFocused = false,
  onToggleFocus,
  dropSide,
  onConnectHost,
}: SftpPaneProps) {
  const splitPane = useSftpStore((s) => s.splitPane);
  const removePane = useSftpStore((s) => s.removePane);
  const setActivePane = useSftpStore((s) => s.setActivePane);
  const connectLocal = useSftpStore((s) => s.connectLocal);
  const [showHostPicker, setShowHostPicker] = useState(false);

  const { ref, isDragging } = useDraggable({
    id: `sftp-pane:${pane.id}`,
    data: { type: "sftp-pane-source", paneId: pane.id },
  });

  const displayName =
    pane.connectionType === "host"
      ? pane.hostName || pane.hostAddress || "Connected"
      : pane.connectionType === "local"
        ? pane.localPath || "Local"
        : "New Pane";

  const sides = ["left", "right", "top", "bottom"] as const;

  return (
    <section
      data-pane-id={pane.id}
      aria-label={displayName}
      tabIndex={-1}
      onKeyDown={accessibleClickHandler(() => setActivePane(pane.id))}
      onClick={() => setActivePane(pane.id)}
      className={`flex flex-col h-full min-h-0 min-w-0 bg-dark-950 relative ${
        isActive
          ? "ring-1 ring-inset ring-primary-600/60"
          : "ring-1 ring-inset ring-dark-800"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <PaneHeader
        title={displayName}
        isActive={isActive}
        closable={closable}
        draggable={draggable}
        dragHandleRef={ref}
        isFocused={isFocused}
        onToggleFocus={canFocus ? onToggleFocus : undefined}
        onSplitH={() => splitPane(pane.id, "horizontal")}
        onSplitV={() => splitPane(pane.id, "vertical")}
        onClose={() => removePane(pane.id)}
      />

      {/* Body */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {pane.connectionType === "host" && pane.hostId ? (
          <FileBrowser
            paneId={pane.id}
            hostId={pane.hostId}
            hostAddress={pane.hostAddress}
            hostPort={pane.hostPort}
            hostUsername={pane.hostUsername}
            onFileSelect={() => {}}
          />
        ) : pane.connectionType === "local" ? (
          <LocalFileBrowser paneId={pane.id} rootPath={pane.localPath || "/"} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <FolderIcon className="w-12 h-12 mx-auto mb-3 text-dark-600" />
              <p className="text-sm text-dark-400 mb-3">
                Connect to a host or local filesystem to browse files
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowHostPicker(true);
                  }}
                >
                  <DesktopTowerIcon className="w-3.5 h-3.5" />
                  Connect Host
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      const path = await openDirectoryPicker();
                      if (path) connectLocal(pane.id, path);
                    } catch (err) {
                      toast.error(
                        extractError(err, "Failed to open directory picker"),
                      );
                    }
                  }}
                >
                  <FolderIcon className="w-3.5 h-3.5" />
                  Connect Local
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Drop zones */}
        {sides.map((side) => (
          <DropZone
            key={side}
            id={`sftp-drop:${pane.id}:${side}`}
            side={side}
            data={{ type: "sftp-pane", paneId: pane.id, side }}
            accept={(draggable) => draggable.data?.type === "sftp-pane-source"}
          />
        ))}

        {/* Drop preview */}
        {dropSide && <div style={previewStyle(dropSide)} />}
      </div>

      {/* Host picker modal */}
      <Modal
        open={showHostPicker}
        onClose={() => setShowHostPicker(false)}
        title="Connect Host"
        maxWidth="max-w-lg"
      >
        <SftpHostPicker
          onConnect={onConnectHost}
          onClose={() => setShowHostPicker(false)}
        />
      </Modal>
    </section>
  );
}
