import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  attachSession,
  destroySession,
  detachSession,
  fitSession,
  getOrCreateSession,
  type Session,
} from "@/lib/terminal/sessionManager";
import { useHostStore } from "@/stores/hosts/hostStore";
import {
  findLeaf,
  type ReconnectState,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";

const SSH_PROGRESS_STEP: Record<string, number> = {
  resolving: 0,
  connecting: 1,
  host_key: 2,
  authenticating: 3,
  starting_shell: 4,
};

const SSH_STEPS = [
  "Resolving hostname...",
  "Establishing SSH connection...",
  "Verifying host key...",
  "Authenticating...",
  "Starting shell...",
];

const LOCAL_STEPS = ["Starting shell..."];

interface TerminalProps {
  hostId: string;
  hostName: string;
  tabId: string;
  paneId: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  authType?: "password" | "key" | "both" | "none";
  keyId?: string;
  connectionType?: "ssh" | "local";
  shell?: string;
  isActive?: boolean;
}

export default function Terminal({
  hostId,
  hostName,
  tabId,
  paneId,
  hostAddress,
  hostPort,
  hostUsername,
  authType,
  keyId,
  connectionType,
  shell,
  isActive,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(
    null,
  );
  const [connectionStatus, setConnectionStatus] = useState<string>("idle");
  const [connStep, setConnStep] = useState<number | null>(() => {
    const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
    const leaf = tab ? findLeaf(tab.root, paneId) : null;
    return leaf && leaf.connectionStatus === "connected" ? null : 0;
  });

  useEffect(() => {
    const unsub = useTerminalStore.subscribe((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const leaf = findLeaf(tab.root, paneId);
      if (!leaf) return;
      setReconnectState(leaf.reconnect);
      setConnectionStatus(leaf.connectionStatus);
    });
    return unsub;
  }, [tabId, paneId]);

  // Advance connection steps from real backend progress events
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<{ sessionId: string; step: string }>(
        "ssh-progress",
        (e) => {
          if (e.payload.sessionId !== paneId) return;
          const idx = SSH_PROGRESS_STEP[e.payload.step];
          if (idx !== undefined) setConnStep(idx);
        },
      );
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [paneId]);

  // Clear connection steps once the session reaches a final state
  useEffect(() => {
    if (connStep === null) return;
    const unsub = useTerminalStore.subscribe((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const paneLeaf = findLeaf(tab.root, paneId);
      if (!paneLeaf) return;
      const s = paneLeaf.connectionStatus;
      if (
        s === "connected" ||
        s === "error" ||
        s === "disconnected" ||
        s === "failed" ||
        s === "reconnecting"
      ) {
        setConnStep(null);
      }
    });
    return unsub;
  }, [connStep, tabId, paneId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const session: Session = getOrCreateSession({
      paneId,
      tabId,
      hostId,
      hostName,
      hostAddress,
      hostPort,
      hostUsername,
      authType,
      keyId,
      connectionType,
      shell,
    });
    attachSession(session, el);

    return () => {
      detachSession(session, el);
      const exists = useTerminalStore
        .getState()
        .tabs.some((t) => paneExistsInTree(t.root, paneId));
      if (!exists) destroySession(paneId);
    };
  }, [
    paneId,
    hostName,
    hostUsername,
    hostAddress,
    hostPort,
    hostId,
    tabId,
    authType,
    keyId,
    connectionType,
    shell,
  ]);

  useEffect(() => {
    const session = getOrCreateSession({
      paneId,
      tabId,
      hostId,
      hostName,
      hostAddress,
      hostPort,
      hostUsername,
      authType,
      keyId,
      connectionType,
      shell,
    });
    session.params.tabId = tabId;
    if (isActive) {
      const timer = setTimeout(() => fitSession(paneId), 50);
      return () => clearTimeout(timer);
    }
  }, [
    isActive,
    tabId,
    paneId,
    hostId,
    hostUsername,
    hostName,
    hostPort,
    hostAddress,
    authType,
    keyId,
    connectionType,
    shell,
  ]);

  const steps = connectionType === "local" ? LOCAL_STEPS : SSH_STEPS;

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {connStep !== null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-950/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <span className="text-xs font-medium text-dark-400 mb-1">
              {connectionType === "local"
                ? hostName || "Local"
                : hostAddress
                  ? `${hostAddress}:${hostPort || 22}`
                  : hostName}
            </span>
            {steps.map((text, i) => (
              <div
                key={text}
                className={`flex items-center gap-2 text-sm transition-opacity duration-300 ${
                  i <= connStep
                    ? "opacity-100 text-dark-200"
                    : "opacity-30 text-dark-500"
                }`}
              >
                {i < connStep ? (
                  <span className="text-green-400">✓</span>
                ) : i === connStep ? (
                  <span className="w-3 h-3 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="w-3 h-3" />
                )}
                {text}
              </div>
            ))}
          </div>
        </div>
      )}
      {reconnectState && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <ArrowClockwiseIcon
              className="w-6 h-6 text-primary-400 animate-spin"
              weight="bold"
            />
            <span className="text-sm text-dark-200">
              Reconnecting in {reconnectState.countdown}s... (attempt{" "}
              {reconnectState.attempt}/{reconnectState.maxAttempts})
            </span>
          </div>
        </div>
      )}
      {!reconnectState && connectionStatus === "failed" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <WarningCircleIcon className="w-6 h-6 text-red-400" weight="bold" />
            <span className="text-sm text-dark-200">Connection lost</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  const session = getOrCreateSession({
                    paneId,
                    tabId,
                    hostId,
                    hostName,
                    hostAddress,
                    hostPort,
                    hostUsername,
                    authType,
                    keyId,
                    connectionType,
                    shell,
                  });
                  useTerminalStore
                    .getState()
                    .updatePaneReconnectState(tabId, paneId, null);
                  useTerminalStore
                    .getState()
                    .updatePaneConnectionStatus(tabId, paneId, "connecting");
                  session.cancelReconnect?.();
                  const { invoke } = await import("@tauri-apps/api/core");
                  const savedHost = useHostStore
                    .getState()
                    .hosts.find((h) => h.id === hostId);
                  try {
                    if (savedHost) {
                      await invoke("connect_saved", {
                        sessionId: paneId,
                        hostId,
                        detectOs: !savedHost.os,
                        cols: session.xterm.cols,
                        rows: session.xterm.rows,
                      });
                    } else {
                      await invoke("connect", {
                        sessionId: paneId,
                        config: {
                          host: hostAddress || "",
                          port: hostPort || 22,
                          username: hostUsername || "root",
                          password: null,
                          privateKey: null,
                          passphrase: null,
                          detectOs: false,
                        },
                        cols: session.xterm.cols,
                        rows: session.xterm.rows,
                      });
                    }
                  } catch {
                    // Reconnect will be triggered by the disconnected event
                  }
                }}
                className="px-3 py-1.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-500 transition-colors"
              >
                Reconnect
              </button>
              <button
                type="button"
                onClick={() => useTerminalStore.getState().removeTab(tabId)}
                className="px-3 py-1.5 text-xs font-medium text-dark-200 bg-dark-700 rounded hover:bg-dark-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function paneExistsInTree(
  node: import("@/stores/terminal/terminalStore").PaneNode,
  paneId: string,
): boolean {
  if (node.type === "leaf") return node.id === paneId;
  return node.children.some((c) => paneExistsInTree(c, paneId));
}
