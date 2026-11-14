import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    entries: async () => [],
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
