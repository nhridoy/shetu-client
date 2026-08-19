import { useEffect, useRef } from "react";
import {
  attachSession,
  destroySession,
  detachSession,
  fitSession,
  getOrCreateSession,
  type Session,
} from "@/lib/terminal/sessionManager";
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

  return <div ref={containerRef} className="w-full h-full" />;
}

function paneExistsInTree(
  node: import("@/stores/terminal/terminalStore").PaneNode,
  paneId: string,
): boolean {
  if (node.type === "leaf") return node.id === paneId;
  return node.children.some((c) => paneExistsInTree(c, paneId));
}
