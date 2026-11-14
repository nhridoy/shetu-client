// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  emit: null as null | ((payload: Record<string, unknown>) => void),
  save: vi.fn(),
  drop: vi.fn(),
  forget: vi.fn(),
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
  connectSavedTerminal: vi.fn(async () => {}),
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
