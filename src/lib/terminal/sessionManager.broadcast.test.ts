// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  connectSaved: vi.fn(),
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
});
