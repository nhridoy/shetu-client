import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import {
  type TerminalTheme,
  terminalThemeFor,
  useThemeStore,
} from "@/stores/themeStore";
import { connectSavedTerminal } from "./agentForwarding";
import {
  beginHistoryAttempt,
  captureHistoryOutput,
  finishHistoryAttempt,
  markHistoryConnected,
} from "./sessionHistory";
import { handleTerminalKey } from "./terminalKeys";

export interface SessionParams {
  paneId: string;
  tabId: string;
  hostId: string;
  hostName: string;
  hostAddress?: string;
  hostPort?: number;
  hostUsername?: string;
  authType?: "password" | "key" | "both" | "none";
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
  cancelReconnect: (() => void) | null;
  historyAttemptId: string | null;
  /** Set as soon as the pane starts closing, so a pending connect gives up. */
  closed: boolean;
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
  xterm.attachCustomKeyEventHandler((e) =>
    handleTerminalKey(e, xterm, navigator.platform.includes("Mac")),
  );

  const session: Session = {
    params,
    xterm,
    fitAddon,
    container,
    opened: false,
    resizeObserver: null,
    resizeRaf: 0,
    unlisten: null,
    cancelReconnect: null,
    historyAttemptId: null,
    closed: false,
  };

  return session;
}

async function connectViaTauri(session: Session) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const { params, xterm } = session;
  const cols = xterm.cols;
  const rows = xterm.rows;

  const update = useTerminalStore.getState().updatePaneConnectionStatus;
  const updateReconnect = useTerminalStore.getState().updatePaneReconnectState;
  update(params.tabId, params.paneId, "connecting");

  let reconnectCleanup: (() => void) | null = null;
  let destroyed = false;

  const clearReconnect = () => {
    reconnectCleanup?.();
    reconnectCleanup = null;
  };

  session.cancelReconnect = () => {
    destroyed = true;
    clearReconnect();
  };

  const doConnect = async () => {
    const attemptId = await beginHistoryAttempt(
      params.hostId,
      params.hostName,
      "ssh",
      params.paneId,
    );
    // Pane closed while the start was pending: destroySession saw no attempt to finish.
    if (destroyed || session.closed) {
      await finishHistoryAttempt(attemptId, "ended", "pane closed");
      return;
    }
    session.historyAttemptId = attemptId;
    const savedHost = params.hostId
      ? useHostStore.getState().hosts.find((h) => h.id === params.hostId)
      : undefined;

    try {
      if (savedHost) {
        await connectSavedTerminal(
          {
            sessionId: params.paneId,
            hostId: params.hostId,
            detectOs: !savedHost.os,
            cols,
            rows,
          },
          () => destroyed || session.closed,
        );
      } else {
        const config = {
          host: params.hostAddress || "",
          port: params.hostPort || 22,
          username: params.hostUsername || "root",
          password: null,
          privateKey: null,
          passphrase: null,
          detectOs: false,
        };
        await invoke("connect", {
          sessionId: params.paneId,
          config,
          cols,
          rows,
        });
      }
    } catch (error) {
      await finishHistoryAttempt(
        session.historyAttemptId,
        "failed",
        String(error),
      );
      session.historyAttemptId = null;
      throw error;
    }
  };

  const MAX_RECONNECT_ATTEMPTS = 2;
  const RECONNECT_COUNTDOWN = 5;

  const startReconnect = () => {
    if (destroyed) return;
    let attempt = 1;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };

    reconnectCleanup = cleanup;

    const doRetry = async () => {
      cleanup();
      if (destroyed) return;

      try {
        await doConnect();
      } catch {
        attempt++;
        if (attempt > MAX_RECONNECT_ATTEMPTS || destroyed) {
          update(params.tabId, params.paneId, "failed");
          updateReconnect(params.tabId, params.paneId, null);
          return;
        }
        startCountdown();
      }
    };

    const startCountdown = () => {
      let remaining = RECONNECT_COUNTDOWN;

      const emit = () => {
        updateReconnect(params.tabId, params.paneId, {
          attempt,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          countdown: remaining,
        });
      };

      update(params.tabId, params.paneId, "reconnecting");
      emit();

      countdownTimer = setInterval(() => {
        if (destroyed) {
          cleanup();
          return;
        }
        remaining--;
        if (remaining <= 0) {
          cleanup();
          doRetry();
        } else {
          emit();
        }
      }, 1000);
    };

    startCountdown();
  };

  try {
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
          void markHistoryConnected(session.historyAttemptId);
          clearReconnect();
          updateReconnect(params.tabId, params.paneId, null);
          update(params.tabId, params.paneId, "connected");
          if (event.payload.os && params.hostId) {
            void useHostStore
              .getState()
              .updateHostOs(params.hostId, event.payload.os);
          }
          break;
        case "output":
          xterm.write(data);
          void captureHistoryOutput(session.historyAttemptId, data);
          break;
        case "disconnected":
          void finishHistoryAttempt(
            session.historyAttemptId,
            "ended",
            "remote disconnected",
          );
          session.historyAttemptId = null;
          startReconnect();
          break;
        case "error":
          void finishHistoryAttempt(session.historyAttemptId, "failed", data);
          session.historyAttemptId = null;
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

    await doConnect();
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

  const update = useTerminalStore.getState().updatePaneConnectionStatus;
  update(params.tabId, params.paneId, "connecting");

  try {
    const attemptId = await beginHistoryAttempt(
      params.hostId,
      params.hostName,
      "local",
      params.paneId,
    );
    if (session.closed) {
      await finishHistoryAttempt(attemptId, "ended", "pane closed");
      return;
    }
    session.historyAttemptId = attemptId;
    const unlisten = await listen<{
      sessionId: string;
      type: string;
      data: string;
    }>("ssh-output", (event) => {
      const { sessionId, type, data } = event.payload;
      if (sessionId !== params.paneId) return;

      switch (type) {
        case "connected":
          void markHistoryConnected(session.historyAttemptId);
          update(params.tabId, params.paneId, "connected");
          break;
        case "output":
          xterm.write(data);
          void captureHistoryOutput(session.historyAttemptId, data);
          break;
        case "disconnected":
          void finishHistoryAttempt(
            session.historyAttemptId,
            "ended",
            "shell exited",
          );
          session.historyAttemptId = null;
          xterm.writeln(`\r\n\x1b[33mShell exited\x1b[0m`);
          update(params.tabId, params.paneId, "disconnected");
          break;
        case "error":
          void finishHistoryAttempt(session.historyAttemptId, "failed", data);
          session.historyAttemptId = null;
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

    await invoke("connect_local", {
      sessionId: params.paneId,
      shell: params.shell || null,
      cols,
      rows,
    });
  } catch (err) {
    await finishHistoryAttempt(session.historyAttemptId, "failed", String(err));
    session.historyAttemptId = null;
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

export const getSession = (paneId: string) => sessions.get(paneId);

/**
 * Types `text` at the prompt like a paste; `run` also presses Enter. Returns false, without
 * typing anything, when inserting several lines into a shell that would run each one.
 */
export function insertIntoTerminal(
  term: Pick<XTerminal, "paste" | "input" | "focus"> & {
    modes: Pick<XTerminal["modes"], "bracketedPasteMode">;
  },
  text: string,
  run: boolean,
): "ok" | "unsafe-multiline" | "empty" {
  // Control characters (incl. ESC, so no fake bracketed-paste end) never reach the shell;
  // trailing newlines would run the command even when the user only inserts.
  const clean = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\n+$/, "");
  // Nothing to type; with `run`, Enter would submit whatever is already at the prompt.
  if (!clean.trim()) return "empty";
  // Without bracketed paste, xterm sends each newline as Enter: the lines would run.
  if (!run && clean.includes("\n") && !term.modes.bracketedPasteMode) {
    return "unsafe-multiline";
  }
  term.paste(clean);
  if (run) term.input("\r");
  term.focus();
  return "ok";
}

export type InsertResult = ReturnType<typeof insertIntoTerminal> | "no-pane";

/** Inserts into a pane's terminal. */
export function insertIntoPane(
  paneId: string,
  text: string,
  run: boolean,
): InsertResult {
  const session = sessions.get(paneId);
  if (!session) return "no-pane";
  return insertIntoTerminal(session.xterm, text, run);
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
  const closing = sessions.get(paneId);
  if (closing) closing.closed = true;
  // Forward definitions remain saved, but their listeners belong to this pane.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stop_port_forwards_for_owner", { ownerPaneId: paneId });
  } catch {
    // Continue disposing the terminal if forwarding is already stopped.
  }

  const session = sessions.get(paneId);
  if (!session) return;
  session.cancelReconnect?.();
  await finishHistoryAttempt(session.historyAttemptId, "ended", "pane closed");
  session.historyAttemptId = null;
  session.resizeObserver?.disconnect();
  if (session.resizeRaf) cancelAnimationFrame(session.resizeRaf);

  session.unlisten?.();

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
