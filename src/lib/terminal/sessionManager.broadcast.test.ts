// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  connectSaved: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    modes = { bracketedPasteMode: false };
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open() {}
    onData() {}
    onResize() {}
    writeln() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("sonner", () => ({ toast: { warning: m.warning } }));
vi.mock("./agentForwarding", () => ({ connectSavedTerminal: m.connectSaved }));
vi.mock("./sessionHistory", () => ({
  beginHistoryAttempt: m.begin,
  captureHistoryOutput: vi.fn(),
  finishHistoryAttempt: m.finish,
  markHistoryConnected: vi.fn(),
}));

import { useTerminalStore } from "@/stores/terminal/terminalStore";
import {
  destroySession,
  getOrCreateSession,
  insertIntoPane,
  sendInput,
} from "./sessionManager";

describe("broadcast fan-out", () => {
  it("fan-out follows the toggle", async () => {
    const store = useTerminalStore.getState();
    useTerminalStore.setState({ tabs: [], activeTabId: null });
    const tabId = store.addEmptyTab();
    const a = useTerminalStore.getState().tabs[0].activePaneId as string;
    store.splitPane(tabId, a, "horizontal");
    const b = useTerminalStore.getState().tabs[0].activePaneId as string;
    for (const id of [a, b])
      useTerminalStore
        .getState()
        .updatePaneConnectionStatus(tabId, id, "connected");
    const sa = getOrCreateSession({
      paneId: a,
      tabId,
      hostId: "h",
      hostName: "x",
    });
    const sb = getOrCreateSession({
      paneId: b,
      tabId,
      hostId: "h",
      hostName: "y",
    });
    sa.send = vi.fn();
    sb.send = vi.fn();

    sendInput(sa, "ls\r");
    expect(sa.send).toHaveBeenCalledWith("ls\r");
    expect(sb.send).not.toHaveBeenCalled();

    useTerminalStore.getState().toggleBroadcast(tabId);
    sendInput(sa, "uptime\r");
    expect(sb.send).toHaveBeenCalledWith("uptime\r");
    expect(sa.send).toHaveBeenCalledTimes(2);

    useTerminalStore.getState().toggleBroadcast(tabId);
    sendInput(sa, "exit\r");
    expect(sb.send).toHaveBeenCalledTimes(1);

    await destroySession(a);
    await destroySession(b);
  });

  async function broadcastingPair() {
    useTerminalStore.setState({ tabs: [], activeTabId: null });
    const store = useTerminalStore.getState();
    const tabId = store.addEmptyTab();
    const a = useTerminalStore.getState().tabs[0].activePaneId as string;
    store.splitPane(tabId, a, "horizontal");
    const b = useTerminalStore.getState().tabs[0].activePaneId as string;
    for (const id of [a, b])
      useTerminalStore
        .getState()
        .updatePaneConnectionStatus(tabId, id, "connected");
    useTerminalStore.getState().toggleBroadcast(tabId);
    const sa = getOrCreateSession({
      paneId: a,
      tabId,
      hostId: "h",
      hostName: "x",
    });
    const sb = getOrCreateSession({
      paneId: b,
      tabId,
      hostId: "h",
      hostName: "y",
    });
    sa.send = vi.fn();
    sb.send = vi.fn();
    return {
      sa,
      sb,
      done: () => Promise.all([destroySession(a), destroySession(b)]),
    };
  }

  it("a pane that connects mid-line joins at the next line", async () => {
    const { sa, sb, done } = await broadcastingPair();
    const tabId = sa.params.tabId as string;
    const late = useTerminalStore.getState().tabs[0].activePaneId as string;
    useTerminalStore.getState().splitPane(tabId, late, "vertical");
    const c = useTerminalStore.getState().tabs[0].activePaneId as string;
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, c, "connected");
    const sc = getOrCreateSession({
      paneId: c,
      tabId,
      hostId: "h",
      hostName: "z",
    });
    sc.send = vi.fn();
    sendInput(sa, "sudo rebo");
    expect(sc.send).not.toHaveBeenCalled();
    sendInput(sa, "ot\r");
    expect(sc.send).not.toHaveBeenCalled();
    sendInput(sa, "uptime\r");
    expect(sc.send).toHaveBeenCalledWith("uptime\r");
    expect(sb.send).toHaveBeenCalledTimes(3);
    await destroySession(c);
    await done();
  });

  it("an unbracketed multi-line paste is wrapped for safe panes and skipped elsewhere", async () => {
    const { sa, sb, done } = await broadcastingPair();
    m.warning.mockClear();
    // Source without bracketed paste: xterm sends the lines raw, joined by \r.
    sendInput(sa, "echo first\recho second");
    expect(sa.send).toHaveBeenCalledWith("echo first\recho second");
    expect(sb.send).not.toHaveBeenCalled();
    expect(m.warning).toHaveBeenCalledWith(
      "Paste not sent to 1 pane without bracketed paste",
    );
    (sb.xterm.modes as { bracketedPasteMode: boolean }).bracketedPasteMode =
      true;
    sendInput(sa, "echo first\recho second");
    expect(sb.send).toHaveBeenCalledWith(
      "\x1b[200~echo first\recho second\x1b[201~",
    );
    // A paste that starts with ESC is still a multi-line paste.
    sendInput(sa, "\x1b[A\recho second");
    expect(sb.send).toHaveBeenLastCalledWith(
      "\x1b[200~\x1b[A\recho second\x1b[201~",
    );
    // Alt+Enter is a key, not a paste.
    sendInput(sa, "\x1b\r");
    expect(sb.send).toHaveBeenLastCalledWith("\x1b\r");
    await done();
  });

  it("a waiting pane joins only when a typed chunk ends the line", async () => {
    const { sa, done } = await broadcastingPair();
    const tabId = sa.params.tabId as string;
    const first = useTerminalStore.getState().tabs[0].activePaneId as string;
    useTerminalStore.getState().splitPane(tabId, first, "vertical");
    const c = useTerminalStore.getState().tabs[0].activePaneId as string;
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, c, "connected");
    const sc = getOrCreateSession({
      paneId: c,
      tabId,
      hostId: "h",
      hostName: "z",
    });
    sc.send = vi.fn();
    sendInput(sa, "echo first\recho sec");
    sendInput(sa, "ond\r");
    expect(sc.send).not.toHaveBeenCalled();
    sendInput(sa, "date\r");
    expect(sc.send).toHaveBeenCalledWith("date\r");
    await destroySession(c);
    await done();
  });

  it("a background insert reaches only its own pane", async () => {
    const { sa, sb, done } = await broadcastingPair();
    // Like xterm: paste and input fire onData synchronously.
    Object.assign(sa.xterm, {
      paste: (d: string) => sendInput(sa, d),
      input: (d: string) => sendInput(sa, d),
      focus: () => {},
      modes: { bracketedPasteMode: true },
    });
    insertIntoPane(sa.params.paneId, "uptime", true, { fanOut: false });
    expect(sa.send).toHaveBeenCalledWith("uptime");
    expect(sb.send).not.toHaveBeenCalled();
    insertIntoPane(sa.params.paneId, "date", true);
    expect(sb.send).toHaveBeenCalledWith("date");
    await done();
  });

  it("terminal replies stay in their own pane", async () => {
    const { sa, sb, done } = await broadcastingPair();
    for (const reply of [
      "\x1b[?1;2c", // device attributes
      "\x1b[12;5R", // cursor position
      "\x1b[0n", // status report
      "\x1b[I", // focus in
      "\x1b[O", // focus out
      "\x1b[<0;12;5M", // SGR mouse
      "\x1b[M !!", // X10 mouse
      "\x1b]11;rgb:0000/0000/0000\x07", // OSC colour reply
      "\x1bP1$r0m\x1b\\", // DECRQSS reply
      "\x1b[?2004;2$y", // DECRPM
    ])
      sendInput(sa, reply);
    expect(sa.send).toHaveBeenCalledTimes(10);
    expect(sb.send).not.toHaveBeenCalled();
    // Real keys that start with ESC still go everywhere.
    for (const key of ["\x1b[A", "\x1bOA", "\x1b[15~", "\x1b[Z", "\x1bb"])
      sendInput(sa, key);
    expect(sb.send).toHaveBeenCalledTimes(5);
    await done();
  });

  it("a multi-line paste skips panes without bracketed paste", async () => {
    const { sa, sb, done } = await broadcastingPair();
    const paste = "\x1b[200~echo a\recho b\x1b[201~";
    sendInput(sa, paste);
    expect(sb.send).not.toHaveBeenCalled();
    expect(m.warning).toHaveBeenCalledWith(
      "Paste not sent to 1 pane without bracketed paste",
    );
    (sb.xterm.modes as { bracketedPasteMode: boolean }).bracketedPasteMode =
      true;
    sendInput(sa, paste);
    expect(sb.send).toHaveBeenCalledWith(paste);
    // A one-line paste is safe everywhere.
    (sb.xterm.modes as { bracketedPasteMode: boolean }).bracketedPasteMode =
      false;
    sendInput(sa, "\x1b[200~uptime\x1b[201~");
    expect(sb.send).toHaveBeenCalledTimes(2);
    await done();
  });
});
