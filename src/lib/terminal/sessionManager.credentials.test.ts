// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  emit: null as null | ((payload: Record<string, unknown>) => void),
  save: vi.fn(),
  drop: vi.fn(),
  forget: vi.fn(),
  connectSaved: vi.fn(async () => {}),
  status: vi.fn(),
  Cancelled: class ConnectCancelled extends Error {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, handler: (e: { payload: unknown }) => void) => {
      m.emit = (payload) => handler({ payload });
      return () => {};
    },
  ),
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
    write() {}
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
vi.mock("./agentForwarding", () => ({
  connectSavedTerminal: m.connectSaved,
  ConnectCancelled: m.Cancelled,
}));
vi.mock("./sessionHistory", () => ({
  beginHistoryAttempt: vi.fn(async () => "a1"),
  captureHistoryOutput: vi.fn(),
  finishHistoryAttempt: vi.fn(async () => {}),
  markHistoryConnected: vi.fn(),
}));
vi.mock("./pendingCredentials", () => ({
  savePendingCredentials: m.save,
  dropPendingCredentials: m.drop,
  forgetSession: m.forget,
}));

import { useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import {
  attachSession,
  destroySession,
  getOrCreateSession,
} from "./sessionManager";

async function open(paneId: string) {
  useHostStore.setState({ hosts: [{ id: "h1", os: "linux" }] } as never);
  m.emit = null;
  const session = getOrCreateSession({
    paneId,
    tabId: "t1",
    hostId: "h1",
    hostName: "prod",
  });
  attachSession(session, document.body);
  await vi.waitFor(() => expect(m.emit).not.toBeNull());
  return (type: string) => m.emit?.({ sessionId: paneId, type, data: "boom" });
}

beforeEach(() => {
  m.save.mockReset();
  m.drop.mockReset();
  m.forget.mockReset();
  m.connectSaved.mockReset().mockResolvedValue(undefined);
  m.status.mockReset();
  useTerminalStore.setState({
    updatePaneConnectionStatus: m.status,
    updatePaneReconnectState: vi.fn(),
  } as never);
});

describe("credentials typed while connecting", () => {
  it("are saved when the session connects", async () => {
    const emit = await open("c1");
    emit("connected");
    expect(m.save).toHaveBeenCalledWith("c1");
    await destroySession("c1");
  });

  it("are dropped, not saved, on error", async () => {
    const emit = await open("c2");
    emit("error");
    expect(m.drop).toHaveBeenCalledWith("c2");
    expect(m.save).not.toHaveBeenCalled();
    await destroySession("c2");
  });

  it("are dropped, not saved, on disconnect", async () => {
    const emit = await open("c3");
    emit("disconnected");
    expect(m.drop).toHaveBeenCalledWith("c3");
    expect(m.save).not.toHaveBeenCalled();
    await destroySession("c3");
  });

  it("are forgotten when the pane closes", async () => {
    await open("c4");
    await destroySession("c4");
    expect(m.forget).toHaveBeenCalledWith("c4");
    expect(m.save).not.toHaveBeenCalled();
  });
});

describe("cancelling the username question during auto-reconnect", () => {
  it("fails at once instead of asking again", async () => {
    const emit = await open("r1");
    await vi.waitFor(() => expect(m.connectSaved).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      m.connectSaved.mockRejectedValue(new m.Cancelled("cancelled"));
      emit("disconnected");
      await vi.advanceTimersByTimeAsync(5000);
      expect(m.connectSaved).toHaveBeenCalledTimes(2);
      expect(m.status).toHaveBeenLastCalledWith("t1", "r1", "failed");
      await vi.advanceTimersByTimeAsync(15000);
      expect(m.connectSaved).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await destroySession("r1");
    }
  });
});
