import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import {
  type TerminalTheme,
  terminalThemeFor,
  useThemeStore,
} from "@/stores/themeStore";

export interface SessionParams {
  paneId: string;
  tabId: string;
  hostId: string;
  hostName: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  authType?: "password" | "key";
  keyId?: string;
  connectionType?: "ssh" | "local";
  shell?: string;
}

export interface Session {
  params: SessionParams;
  xterm: XTerminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  opened: boolean;
  resizeObserver: ResizeObserver | null;
  resizeRaf: number;
  unlisten: (() => void) | null;
  unlistenHostKey: (() => void) | null;
}

const sessions = new Map<string, Session>();

function createSession(params: SessionParams): Session {
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  container.style.display = "block";

  const xterm = new XTerminal({
    theme: terminalThemeFor(useThemeStore.getState().currentTheme),
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontSize: 14,
    cursorBlink: true,
    cursorStyle: "block",
    allowTransparency: true,
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());

  const session: Session = {
    params,
    xterm,
    fitAddon,
    container,
    opened: false,
    resizeObserver: null,
    resizeRaf: 0,
    unlisten: null,
    unlistenHostKey: null,
  };

  return session;
}

async function connectViaTauri(session: Session) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const { params, xterm } = session;
  const cols = xterm.cols;
  const rows = xterm.rows;

  xterm.writeln("\x1b[1;36mTermVault\x1b[0m - Self-hosted SSH Client");
  xterm.writeln("");
  xterm.writeln(`\x1b[33mConnecting to ${params.hostName}...\x1b[0m`);
  xterm.writeln("");

  const update = useTerminalStore.getState().updatePaneConnectionStatus;
  update(params.tabId, params.paneId, "connecting");

  try {
    const savedHost = params.hostId
      ? useHostStore.getState().hosts.find((h) => h.id === params.hostId)
      : undefined;

    if (savedHost) {
      await invoke("connect_saved", {
        sessionId: params.paneId,
        hostId: params.hostId,
        detectOs: !savedHost.os,
      });
    } else {
      // Direct (QuickConnect) connections have no saved host row — plaintext
      // path stays, but these carry no stored credentials.
      const config = {
        host: params.hostAddress || "",
        port: params.hostPort || 22,
        username: params.hostUsername || "root",
        password: null,
        privateKey: null,
        passphrase: null,
        detectOs: false,
      };
      await invoke("connect", { sessionId: params.paneId, config });
    }

    const unlistenHostKey = await listen<{
      host: string;
      port: number;
      sessionId: string;
      oldFingerprint: string;
      newFingerprint: string;
    }>("ssh-host-key-changed", async (event) => {
      const { host, port, sessionId, oldFingerprint, newFingerprint } =
        event.payload;

      const confirmed = await confirm(
        `SSH Host Key Changed!\n\n` +
          `Host: ${host}:${port}\n\n` +
          `Old fingerprint:\n${oldFingerprint}\n\n` +
          `New fingerprint:\n${newFingerprint}\n\n` +
          `This could indicate a MITM attack. Do you trust this new key?`,
        { title: "Security Warning", kind: "warning" },
      );

      await invoke("accept_host_key", { host, port, accepted: confirmed });
    });

    session.unlistenHostKey = unlistenHostKey;

    const unlisten = await listen<{
      sessionId: string;
      type: string;
      data: string;
      os?: string;
    }>("ssh-output", (event) => {
      const { sessionId, type, data } = event.payload;
      if (sessionId !== params.paneId) return;

      switch (type) {
        case "connected":
          update(params.tabId, params.paneId, "connected");
          if (event.payload.os && params.hostId) {
            void useHostStore
              .getState()
              .updateHostOs(params.hostId, event.payload.os);
          }
          break;
        case "output":
          xterm.write(data);
          break;
        case "disconnected":
          xterm.writeln(`\r\n\x1b[33mConnection closed\x1b[0m`);
          update(params.tabId, params.paneId, "disconnected");
          break;
        case "error":
          xterm.writeln(`\r\n\x1b[31mError: ${data}\x1b[0m`);
          update(params.tabId, params.paneId, "error");
          break;
      }
    });

    session.unlisten = unlisten;

    xterm.onData(async (data) => {
      try {
        await invoke("send_input", { sessionId: params.paneId, data });
      } catch {
        // Session may have been closed
      }
    });

    let lastResize = { cols, rows };
    xterm.onResize(async ({ cols: newCols, rows: newRows }) => {
      if (newCols === lastResize.cols && newRows === lastResize.rows) return;
      lastResize = { cols: newCols, rows: newRows };
      try {
        await invoke("resize", {
          sessionId: params.paneId,
          cols: newCols,
          rows: newRows,
        });
      } catch {
        // Session may have been closed
      }
    });
  } catch (err) {
    xterm.writeln(`\r\n\x1b[31mFailed to connect: ${err}\x1b[0m`);
    update(params.tabId, params.paneId, "error");
  }
}

async function connectLocal(session: Session) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const { params, xterm } = session;
  const cols = xterm.cols;
  const rows = xterm.rows;

  xterm.writeln("\x1b[1;36mTermVault\x1b[0m - Local Terminal");
  xterm.writeln("");
  xterm.writeln(
    `\x1b[33mStarting ${params.shell || "default shell"}...\x1b[0m`,
  );
  xterm.writeln("");

  const update = useTerminalStore.getState().updatePaneConnectionStatus;
  update(params.tabId, params.paneId, "connecting");

  try {
    await invoke("connect_local", {
      sessionId: params.paneId,
      shell: params.shell || null,
      cols,
      rows,
    });

    const unlisten = await listen<{
      sessionId: string;
      type: string;
      data: string;
    }>("ssh-output", (event) => {
      const { sessionId, type, data } = event.payload;
      if (sessionId !== params.paneId) return;

      switch (type) {
        case "connected":
          update(params.tabId, params.paneId, "connected");
          break;
        case "output":
          xterm.write(data);
          break;
        case "disconnected":
          xterm.writeln(`\r\n\x1b[33mShell exited\x1b[0m`);
          update(params.tabId, params.paneId, "disconnected");
          break;
        case "error":
          xterm.writeln(`\r\n\x1b[31mError: ${data}\x1b[0m`);
          update(params.tabId, params.paneId, "error");
          break;
      }
    });

    session.unlisten = unlisten;

    xterm.onData(async (data) => {
      try {
        await invoke("send_input_local", { sessionId: params.paneId, data });
      } catch {
        // Session may have been closed
      }
    });

    let lastResize = { cols, rows };
    xterm.onResize(async ({ cols: newCols, rows: newRows }) => {
      if (newCols === lastResize.cols && newRows === lastResize.rows) return;
      lastResize = { cols: newCols, rows: newRows };
      try {
        await invoke("resize_local", {
          sessionId: params.paneId,
          cols: newCols,
          rows: newRows,
        });
      } catch {
        // Session may have been closed
      }
    });
  } catch (err) {
    xterm.writeln(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m`);
    update(params.tabId, params.paneId, "error");
  }
}

export function attachSession(session: Session, reactEl: HTMLElement) {
  reactEl.appendChild(session.container);
  if (!session.opened) {
    session.xterm.open(session.container);
    session.opened = true;
    fitSessionSafe(session);
    if (session.params.connectionType === "local") {
      connectLocal(session);
    } else {
      connectViaTauri(session);
    }
  }

  const ro = new ResizeObserver(() => {
    if (session.resizeRaf) return;
    session.resizeRaf = requestAnimationFrame(() => {
      session.resizeRaf = 0;
      fitSessionSafe(session);
    });
  });
  ro.observe(session.container);
  session.resizeObserver = ro;
}

export function detachSession(session: Session, reactEl: HTMLElement) {
  session.resizeObserver?.disconnect();
  session.resizeObserver = null;
  if (reactEl.contains(session.container)) {
    reactEl.removeChild(session.container);
  }
}

export function getOrCreateSession(params: SessionParams): Session {
  const existing = sessions.get(params.paneId);
  if (existing) {
    existing.params.tabId = params.tabId;
    return existing;
  }
  const session = createSession(params);
  sessions.set(params.paneId, session);
  return session;
}

export function fitSession(paneId: string) {
  const session = sessions.get(paneId);
  if (!session) return;
  fitSessionSafe(session);
}

function fitSessionSafe(session: Session) {
  const el = session.container;
  if (el.clientWidth === 0 || el.clientHeight === 0) return;
  const { xterm, fitAddon } = session;
  const buffer = xterm.buffer.active;
  const wasAtBottom = buffer.baseY - buffer.viewportY <= 0;
  try {
    fitAddon.fit();
  } catch {
    /* container may not be sized yet */
  }
  if (wasAtBottom) xterm.scrollToBottom();
}

export function applyTerminalTheme() {
  const theme: TerminalTheme = terminalThemeFor(
    useThemeStore.getState().currentTheme,
  );
  for (const session of sessions.values()) {
    session.xterm.options.theme = theme;
  }
}

useThemeStore.subscribe((state, prev) => {
  if (state.currentTheme !== prev.currentTheme) {
    applyTerminalTheme();
  }
});

export async function destroySession(paneId: string) {
  const session = sessions.get(paneId);
  if (!session) return;
  session.resizeObserver?.disconnect();
  if (session.resizeRaf) cancelAnimationFrame(session.resizeRaf);

  session.unlisten?.();
  session.unlistenHostKey?.();

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (session.params.connectionType === "local") {
      await invoke("disconnect_local", { sessionId: paneId });
    } else {
      await invoke("disconnect", { sessionId: paneId });
    }
  } catch {
    // Ignore — session may already be closed
  }

  session.xterm.dispose();
  sessions.delete(paneId);
}
