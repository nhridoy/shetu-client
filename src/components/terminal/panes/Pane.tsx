import { useDraggable } from "@dnd-kit/react";
import {
  ArrowsLeftRightIcon,
  BroadcastIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { DropZone } from "@/components/common/DropZone";
import PortForwarding from "@/components/portforwarding/panels/PortForwarding";
import HostBrowser from "@/components/terminal/browser/HostBrowser";
import Terminal from "@/components/terminal/shell/Terminal";
import { Button } from "@/components/ui/Button";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import PaneHeader from "@/components/ui/PaneHeader";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { previewStyle } from "@/lib/common/paneLayout";
import { onOpenPortForwarding } from "@/lib/terminal/paletteCommand";
import { isPaneRecording } from "@/lib/terminal/sessionHistory";
import { type DropSide, useDragStore } from "@/stores/dragStore";
import type { Host } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

interface PaneProps {
  tabId: string;
  pane: import("@/stores/terminal/terminalStore").LeafNode;
  isActive: boolean;
  closable: boolean;
  draggable?: boolean;
  canFocus?: boolean;
  isFocused?: boolean;
  onToggleFocus?: () => void;
  isActiveTab: boolean;
  onRestorePreset: (
    preset: { id?: string; name?: string; layout: string },
    tabId: string,
  ) => void;
}

export default function Pane({
  tabId,
  pane,
  isActive,
  closable,
  draggable = false,
  canFocus = false,
  isFocused = false,
  onToggleFocus,
  isActiveTab,
  onRestorePreset,
}: PaneProps) {
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const broadcasting = useTerminalStore(
    (s) => !!s.tabs.find((t) => t.id === tabId)?.broadcast,
  );
  // Connected after broadcast started: receives from the next line on.
  const joining = useTerminalStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return (
      !!tab?.broadcast &&
      pane.connectionStatus === "connected" &&
      !tab.broadcastReady?.includes(pane.id)
    );
  });
  const splitPane = useTerminalStore((s) => s.splitPane);
  const removePane = useTerminalStore((s) => s.removePane);
  const connectPane = useTerminalStore((s) => s.connectPane);
  const dropPane = useDragStore((s) => s.dropPane);
  const dropSide: DropSide | null =
    dropPane && dropPane.tabId === tabId && dropPane.paneId === pane.id
      ? dropPane.side
      : null;
  const [showPortForwarding, setShowPortForwarding] = useState(false);
  // The command palette's "Port forwarding" for this pane.
  useEffect(
    () =>
      onOpenPortForwarding((id) => {
        if (id === pane.id) setShowPortForwarding(true);
      }),
    [pane.id],
  );
  const [recording, setRecording] = useState(() => isPaneRecording(pane.id));
  useEffect(() => {
    const refresh = () => setRecording(isPaneRecording(pane.id));
    window.addEventListener("shetu:recording-change", refresh);
    refresh();
    return () => window.removeEventListener("shetu:recording-change", refresh);
  }, [pane.id]);

  const { ref, isDragging } = useDraggable({
    id: `pane:${pane.id}`,
    data: { type: "pane-source", tabId, paneId: pane.id },
  });

  const handleConnect = (host: Host) => {
    connectPane(tabId, pane.id, host.id, host.name, {
      hostAddress: host.address,
      hostPort: host.port ?? undefined,
      hostUsername: host.username,
      authType: host.authType,
      keyId: host.keyId ?? undefined,
    });
  };

  const handleConnectLocal = (shell: string) => {
    connectPane(tabId, pane.id, `local_${Date.now()}`, "Local", {
      connectionType: "local",
      shell,
    });
  };

  const sides = ["left", "right", "top", "bottom"] as const;

  return (
    // biome-ignore lint/a11y/useSemanticElements: terminal pane container with ref and data attributes
    <div
      data-pane-id={pane.id}
      data-tab-id={tabId}
      role="button"
      tabIndex={0}
      className={`flex flex-col h-full min-h-0 min-w-0 bg-dark-950 relative ${
        broadcasting
          ? // The pane you type in stays brighter than the ones that receive.
            isActive
            ? "ring-2 ring-inset ring-amber-400"
            : "ring-2 ring-inset ring-amber-500/50"
          : isActive
            ? "ring-1 ring-inset ring-primary-600/60"
            : "ring-1 ring-inset ring-dark-800"
      } ${dropSide ? "ring-1 ring-inset ring-primary-500" : ""} ${
        isDragging ? "opacity-40" : ""
      }`}
      onMouseDown={() => setActivePane(tabId, pane.id)}
      onKeyDown={accessibleClickHandler(() => setActivePane(tabId, pane.id))}
    >
      <PaneHeader
        title={pane.hostName || "Empty pane"}
        isActive={isActive}
        closable={closable}
        draggable={draggable}
        connectionStatus={pane.connectionStatus}
        dragHandleRef={ref}
        isFocused={isFocused}
        onToggleFocus={canFocus ? onToggleFocus : undefined}
        onSplitH={() => splitPane(tabId, pane.id, "horizontal")}
        onSplitV={() => splitPane(tabId, pane.id, "vertical")}
        onClose={() => removePane(tabId, pane.id)}
        extra={
          <>
            {broadcasting && pane.hostId && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/90 px-1.5 text-[11px] font-medium leading-4 text-dark-950">
                <BroadcastIcon className="size-3" weight="bold" aria-hidden />
                {joining ? "Joins at next line" : "Broadcasting"}
              </span>
            )}
            {recording && (
              <span
                className="text-xs text-red-300"
                title="Terminal output recording active"
              >
                ● REC
              </span>
            )}
            {pane.hostId && pane.connectionType !== "local" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPortForwarding(true);
                }}
                className="rounded"
                title="Port Forwarding"
              >
                <ArrowsLeftRightIcon className="w-3.5 h-3.5" weight="bold" />
              </Button>
            )}
          </>
        }
      />

      {/* Pane body */}
      <div className="flex-1 min-h-0 relative">
        {pane.hostId ? (
          <ErrorBoundary
            onReset={() => {
              const { hostId: hid, hostName: hname, ...rest } = pane;
              if (!hid) return;
              removePane(tabId, pane.id);
              connectPane(tabId, pane.id, hid, hname, {
                hostAddress: rest.hostAddress,
                hostPort: rest.hostPort,
                hostUsername: rest.hostUsername,
                authType: rest.authType,
                keyId: rest.keyId,
                connectionType: rest.connectionType,
                shell: rest.shell,
              });
            }}
          >
            <Terminal
              hostId={pane.hostId}
              hostName={pane.hostName}
              tabId={tabId}
              paneId={pane.id}
              hostAddress={pane.hostAddress}
              hostPort={pane.hostPort}
              hostUsername={pane.hostUsername}
              authType={pane.authType}
              keyId={pane.keyId}
              connectionType={pane.connectionType}
              shell={pane.shell}
              isActive={isActive}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary onReset={() => {}}>
            <HostBrowser
              onConnect={handleConnect}
              onConnectLocal={handleConnectLocal}
              onRestorePreset={(preset) => onRestorePreset(preset, tabId)}
            />
          </ErrorBoundary>
        )}
        {isActiveTab &&
          sides.map((side) => (
            <DropZone
              key={side}
              id={`${pane.id}:${side}`}
              side={side}
              data={{ type: "pane", tabId, paneId: pane.id, side }}
            />
          ))}
        {dropSide && <div style={previewStyle(dropSide)} />}
      </div>

      {/* Port Forwarding Drawer */}
      {showPortForwarding && pane.hostId && pane.connectionType !== "local" && (
        <div className="absolute inset-0 z-50 flex">
          <div className="w-80 bg-dark-900 border-l border-dark-700 flex flex-col">
            <div className="flex items-center justify-between p-2 border-b border-dark-700">
              <span className="text-sm font-medium text-white">
                Port Forwarding
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowPortForwarding(false)}
                className="rounded"
              >
                <XIcon className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              <PortForwarding hostId={pane.hostId} paneId={pane.id} />
            </div>
          </div>
          {/* Backdrop */}
          <Button
            type="button"
            variant="ghost"
            className="flex-1 bg-black/30 cursor-default"
            onClick={() => setShowPortForwarding(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowPortForwarding(false);
            }}
            aria-label="Close port forwarding panel"
          />
        </div>
      )}
    </div>
  );
}
