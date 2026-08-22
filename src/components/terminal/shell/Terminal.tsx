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
import { useTerminalStore } from "@/stores/terminal/terminalStore";

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
  const [reconnectStatus, setReconnectStatus] = useState<
    "idle" | "reconnecting" | "failed"
  >("idle");

  useEffect(() => {
    const unsub = useTerminalStore.subscribe((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const leaf = tab.root.type === "leaf" ? tab.root : null;
      const paneLeaf = leaf?.id === paneId ? leaf : null;
      if (!paneLeaf) return;
      const s = paneLeaf.connectionStatus;
      if (s === "reconnecting") setReconnectStatus("reconnecting");
      else if (s === "failed") setReconnectStatus("failed");
      else setReconnectStatus("idle");
    });
    return unsub;
  }, [tabId, paneId]);

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

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {reconnectStatus !== "idle" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            {reconnectStatus === "reconnecting" ? (
              <>
                <ArrowClockwiseIcon
                  className="w-6 h-6 text-primary-400 animate-spin"
                  weight="bold"
                />
                <span className="text-sm text-dark-200">Reconnecting...</span>
              </>
            ) : (
              <>
                <WarningCircleIcon
                  className="w-6 h-6 text-red-400"
                  weight="bold"
                />
                <span className="text-sm text-dark-200">Connection failed</span>
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
                    setReconnectStatus("idle");
                    useTerminalStore
                      .getState()
                      .updatePaneConnectionStatus(tabId, paneId, "connecting");
                    session.cancelReconnect?.();
                    const { invoke } = await import("@tauri-apps/api/core");
                    const savedHost = useHostStore
                      .getState()
                      .hosts.find((h) => h.id === hostId);
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
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-500 transition-colors"
                >
                  Reconnect
                </button>
              </>
            )}
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
