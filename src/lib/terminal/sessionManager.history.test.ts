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
vi.mock("./agentForwarding", () => ({ connectSavedTerminal: m.connectSaved }));
vi.mock("./sessionHistory", () => ({
  beginHistoryAttempt: m.begin,
  captureHistoryOutput: vi.fn(),
  finishHistoryAttempt: m.finish,
  markHistoryConnected: vi.fn(),
}));

import { useHostStore } from "@/stores/hosts/hostStore";
import {
  attachSession,
  destroySession,
  getOrCreateSession,
} from "./sessionManager";

describe("pane closed while the history attempt is starting", () => {
  it("finishes the late attempt and never connects", async () => {
    m.invoke.mockResolvedValue(undefined);
    useHostStore.setState({ hosts: [{ id: "h1", os: "linux" }] } as never);
    let resolveBegin: (id: string) => void = () => {};
    m.begin.mockReturnValue(new Promise((r) => (resolveBegin = r)));

    const session = getOrCreateSession({
      paneId: "p1",
      tabId: "t1",
      hostId: "h1",
      hostName: "prod",
    });
    attachSession(session, document.body);
    await vi.waitFor(() => expect(m.begin).toHaveBeenCalled());

    await destroySession("p1");
    resolveBegin("late-attempt");
    await vi.waitFor(() =>
      expect(m.finish).toHaveBeenCalledWith(
        "late-attempt",
        "ended",
        "pane closed",
      ),
    );
    expect(m.connectSaved).not.toHaveBeenCalled();
  });
});
