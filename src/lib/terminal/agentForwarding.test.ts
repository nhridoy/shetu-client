import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  entries: async (): Promise<[string, unknown][]> => [],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    entries: () => mocks.entries(),
    set: async () => {},
    save: async () => {},
  }),
}));
vi.mock("@/lib/db/db");
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));

import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import {
  answerAgentForwarding,
  connectSavedTerminal,
  recordAgentForwarding,
  useAgentForwardAsks,
} from "./agentForwarding";

const args = {
  sessionId: "p1",
  hostId: "h1",
  detectOs: false,
  cols: 80,
  rows: 24,
};

function hostWith(forwardAgent: boolean) {
  const getDecryptedHost = vi.fn(async () => ({
    id: "h1",
    name: "prod",
    address: "10.0.0.1",
    forwardAgent,
  }));
  useHostStore.setState({ getDecryptedHost } as never);
  return getDecryptedHost;
}

const asked = () => useAgentForwardAsks.getState().queue;
const nextAsk = () => vi.waitFor(() => expect(asked()).toHaveLength(1));
const decisions = () =>
  useSettingsStore.getState().settings.agentForwardingDecisions;

beforeAll(() => useSettingsStore.getState().initSettings());

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  useAgentForwardAsks.setState({ queue: [] });
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, agentForwardingDecisions: {} },
  }));
});

describe("connectSavedTerminal", () => {
  it("asks once, then remembers Allow", async () => {
    hostWith(true);
    const first = connectSavedTerminal(args);
    await nextAsk();
    expect(asked()[0].host).toBe("prod");
    answerAgentForwarding(true);
    await first;
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: true,
    });
    expect(decisions()).toEqual({ h1: true });

    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: true,
    });
  });

  it("remembers Don't allow without asking again", async () => {
    hostWith(true);
    const first = connectSavedTerminal(args);
    await nextAsk();
    answerAgentForwarding(false);
    await first;
    expect(decisions()).toEqual({ h1: false });

    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: false,
    });
  });

  it("never asks for a host without agent forwarding", async () => {
    hostWith(false);
    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
    expect(decisions()).toEqual({});
    expect(mocks.invoke).toHaveBeenCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: false,
    });
  });

  it("asks once for panes connecting to the same host together", async () => {
    hostWith(true);
    const both = Promise.all([
      connectSavedTerminal(args),
      connectSavedTerminal({ ...args, sessionId: "p2" }),
    ]);
    await nextAsk();
    answerAgentForwarding(true);
    await both;
    expect(asked()).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not connect a pane closed while the question was open", async () => {
    hostWith(true);
    let closed = false;
    const pending = connectSavedTerminal(args, () => closed);
    await nextAsk();
    closed = true;
    answerAgentForwarding(true);
    await pending;
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "connect_saved",
      expect.anything(),
    );
  });
});

describe("recordAgentForwarding", () => {
  it("records and removes a host's decision", async () => {
    await recordAgentForwarding("h1", true);
    expect(decisions()).toEqual({ h1: true });
    await recordAgentForwarding("h1", null);
    expect(decisions()).toEqual({});
  });
});

describe("before saved settings have loaded", () => {
  // A fresh settings store whose load waits until `finishLoad` is called.
  async function loadingStore(saved: [string, unknown][]) {
    let finishLoad = () => {};
    const gate = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    mocks.entries = async () => {
      await gate;
      return saved;
    };
    vi.resetModules();
    const { useSettingsStore } = await import(
      "@/stores/settings/settingsStore"
    );
    const { useHostStore } = await import("@/stores/hosts/hostStore");
    const forwarding = await import("./agentForwarding");
    const getDecryptedHost = async () => ({
      id: "h1",
      name: "prod",
      address: "10.0.0.1",
      forwardAgent: true,
    });
    useHostStore.setState({ getDecryptedHost } as never);
    const init = useSettingsStore.getState().initSettings();
    const decisions = () =>
      useSettingsStore.getState().settings.agentForwardingDecisions;
    return { forwarding, finishLoad, init, decisions };
  }

  it("uses the saved decision instead of asking again", async () => {
    const store = await loadingStore([
      ["agentForwardingDecisions", { h1: true }],
    ]);
    const connecting = store.forwarding.connectSavedTerminal(args);
    store.finishLoad();
    await store.init;
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("connect_saved", {
        ...args,
        allowAgentForwarding: true,
      }),
    );
    await connecting;
    expect(store.forwarding.useAgentForwardAsks.getState().queue).toHaveLength(
      0,
    );
  });

  it("keeps an answer recorded while loading", async () => {
    const store = await loadingStore([
      ["agentForwardingDecisions", { h2: false }],
    ]);
    const recording = store.forwarding.recordAgentForwarding("h1", true);
    store.finishLoad();
    await store.init;
    await recording;
    expect(store.decisions()).toEqual({ h2: false, h1: true });
  });
});
