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

import { getRow } from "@/lib/db/db";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import {
  answerAgentForwarding,
  ConnectCancelled,
  connectSavedTerminal,
  recordAgentForwarding,
  resolveUsernameOrAsk,
  useAgentForwardAsks,
} from "./agentForwarding";
import {
  answerUsername,
  forgetSession,
  isSavedHostSession,
  savePendingCredentials,
  useUsernameAsks,
} from "./pendingCredentials";

const args = {
  sessionId: "p1",
  hostId: "h1",
  detectOs: false,
  cols: 80,
  rows: 24,
};

function hostWith(forwardAgent: boolean | null) {
  const getDecryptedHost = vi.fn(async () => ({
    id: "h1",
    name: "prod",
    address: "10.0.0.1",
    username: "root",
    groupId: "g1",
    vaultId: "v1",
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

describe("inherited forwarding", () => {
  const inheritFrom = (forwardAgent?: boolean) =>
    mocks.invoke.mockImplementation((async (cmd: string) =>
      cmd === "inherited_host_defaults"
        ? { forwardAgent }
        : undefined) as never);

  it("asks for consent when the group turns forwarding on", async () => {
    inheritFrom(true);
    hostWith(null);
    const pending = connectSavedTerminal(args);
    await nextAsk();
    answerAgentForwarding(true);
    await pending;
    expect(mocks.invoke).toHaveBeenCalledWith("inherited_host_defaults", {
      groupId: "g1",
      vaultId: "v1",
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: true,
    });
  });

  it("does not ask when the host turns it off under a group that allows it", async () => {
    inheritFrom(true);
    hostWith(false);
    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: false,
    });
  });

  it("does not ask when nothing in the chain turns it on", async () => {
    inheritFrom(undefined);
    hostWith(null);
    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
  });

  it("does not ask when the group lookup fails", async () => {
    mocks.invoke.mockImplementation((async (cmd: string) => {
      if (cmd === "inherited_host_defaults") throw new Error("boom");
    }) as never);
    hostWith(null);
    await connectSavedTerminal(args);
    expect(asked()).toHaveLength(0);
  });
});

describe("missing username", () => {
  const usernameAsks = () => useUsernameAsks.getState().queue;
  const nextUsernameAsk = () =>
    vi.waitFor(() => expect(usernameAsks()).toHaveLength(1));

  function hostWithout(groupId: string | null, inherited?: string) {
    useUsernameAsks.setState({ queue: [] });
    useHostStore.setState({
      hosts: [{ id: "h1", authType: "key" }],
      getDecryptedHost: vi.fn(async () => ({
        id: "h1",
        name: "",
        address: "10.0.0.1",
        username: "  ",
        groupId,
        vaultId: "v1",
        forwardAgent: false,
      })),
    } as never);
    mocks.invoke.mockImplementation((async (cmd: string) =>
      cmd === "inherited_host_defaults"
        ? { username: inherited }
        : undefined) as never);
  }

  it("asks username when none resolves", async () => {
    hostWithout("g1");
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    expect(usernameAsks()[0].host).toBe("10.0.0.1");
    answerUsername({ username: "deploy", save: false });
    await pending;
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      username: "deploy",
      allowAgentForwarding: false,
    });
  });

  it("asks for a host outside any group", async () => {
    hostWithout(null);
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    answerUsername({ username: "deploy", save: false });
    await pending;
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "inherited_host_defaults",
      expect.anything(),
    );
  });

  it("cancel aborts the connect", async () => {
    hostWithout("g1");
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    answerUsername(null);
    await expect(pending).rejects.toBeInstanceOf(ConnectCancelled);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "connect_saved",
      expect.anything(),
    );
  });

  it("a pane closed during the question opens nothing and does not throw", async () => {
    hostWithout("g1");
    let closed = false;
    const pending = connectSavedTerminal(args, () => closed);
    await nextUsernameAsk();
    closed = true;
    forgetSession(args.sessionId);
    await pending;
    expect(usernameAsks()).toHaveLength(0);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "connect_saved",
      expect.anything(),
    );
  });

  it("no username dialog when group provides one", async () => {
    hostWithout("g1", "ops");
    await connectSavedTerminal(args);
    expect(usernameAsks()).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: false,
    });
  });

  it("username save waits for the session to connect", async () => {
    hostWithout("g1");
    const updateHost = vi.fn(async () => true);
    useHostStore.setState({ updateHost } as never);
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    answerUsername({ username: "deploy", save: true });
    await pending;
    expect(updateHost).not.toHaveBeenCalled();
    await savePendingCredentials(args.sessionId);
    expect(updateHost).toHaveBeenCalledWith(
      "h1",
      { username: "deploy" },
      { passwordAuth: false },
    );
  });

  it("asks without Save when the group lookup fails", async () => {
    hostWithout("g1");
    mocks.invoke.mockImplementation((async (cmd: string) => {
      if (cmd === "inherited_host_defaults") throw new Error("offline");
    }) as never);
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    expect(usernameAsks()[0].canSave).toBe(false);
    answerUsername({ username: "deploy", save: false });
    await pending;
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      username: "deploy",
      allowAgentForwarding: false,
    });
  });

  it("a pane closed during the lookups queues no username question", async () => {
    hostWithout("g1");
    let closed = false;
    const decrypted = useHostStore.getState().getDecryptedHost;
    useHostStore.setState({
      getDecryptedHost: vi.fn(async (id: string) => {
        const host = await decrypted(id);
        closed = true;
        return host;
      }),
    } as never);
    await connectSavedTerminal(args, () => closed);
    expect(usernameAsks()).toHaveLength(0);
  });

  it("offers Save when the group sets no username", async () => {
    hostWithout("g1");
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    expect(usernameAsks()[0].canSave).toBe(true);
    answerUsername(null);
    await expect(pending).rejects.toBeInstanceOf(ConnectCancelled);
  });

  it("resolveUsernameOrAsk asks without Save for non-terminal connects", async () => {
    hostWithout(null);
    const pending = resolveUsernameOrAsk("sftp-1", "h1");
    await nextUsernameAsk();
    expect(usernameAsks()[0].canSave).toBe(false);
    answerUsername({ username: "deploy", save: false });
    await expect(pending).resolves.toBe("deploy");
  });

  it("resolveUsernameOrAsk rejects on cancel and skips hosts that have a user", async () => {
    hostWithout(null);
    const pending = resolveUsernameOrAsk("sftp-1", "h1");
    await nextUsernameAsk();
    answerUsername(null);
    await expect(pending).rejects.toBeInstanceOf(ConnectCancelled);
    hostWithout("g1", "ops");
    await expect(resolveUsernameOrAsk("sftp-1", "h1")).resolves.toBeUndefined();
    expect(usernameAsks()).toHaveLength(0);
  });

  it("an unchecked Save remembers nothing", async () => {
    hostWithout("g1");
    const updateHost = vi.fn(async () => true);
    useHostStore.setState({ updateHost } as never);
    const pending = connectSavedTerminal(args);
    await nextUsernameAsk();
    answerUsername({ username: "deploy", save: false });
    await pending;
    await savePendingCredentials(args.sessionId);
    expect(updateHost).not.toHaveBeenCalled();
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
      username: "root",
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

describe("identity hosts", () => {
  const usernameAsks = () => useUsernameAsks.getState().queue;

  function identityHost(extra: Record<string, unknown>, inherited = {}) {
    useUsernameAsks.setState({ queue: [] });
    useHostStore.setState({
      getDecryptedHost: vi.fn(async () => ({
        id: "h1",
        name: "prod",
        address: "10.0.0.1",
        username: "",
        groupId: null,
        vaultId: "v1",
        forwardAgent: false,
        authType: "identity",
        identityId: "i1",
        ...extra,
      })),
    } as never);
    mocks.invoke.mockImplementation((async (cmd: string) =>
      cmd === "inherited_host_defaults"
        ? { hasPassword: false, startupKind: null, env: [], ...inherited }
        : undefined) as never);
  }

  it("an identity host is never asked for a username and offers no Save", async () => {
    identityHost({});
    vi.mocked(getRow).mockResolvedValue({
      id: "i1",
      vault_id: "v1",
      deleted_at: null,
    } as never);
    await connectSavedTerminal(args);
    expect(usernameAsks()).toHaveLength(0);
    expect(isSavedHostSession(args.sessionId)).toBe(false);
    expect(mocks.invoke).toHaveBeenLastCalledWith("connect_saved", {
      ...args,
      allowAgentForwarding: false,
    });
  });

  it("a host inheriting an identity offers no Save", async () => {
    identityHost(
      { authType: "inherit", username: "root", groupId: "g1" },
      { authType: "identity", authFrom: "prod", username: "deploy" },
    );
    await connectSavedTerminal(args);
    expect(usernameAsks()).toHaveLength(0);
    expect(isSavedHostSession(args.sessionId)).toBe(false);
  });

  it("a deleted identity asks for the username without Save", async () => {
    identityHost({});
    vi.mocked(getRow).mockResolvedValue(null);
    const pending = connectSavedTerminal(args);
    await vi.waitFor(() => expect(usernameAsks()).toHaveLength(1));
    expect(usernameAsks()[0].canSave).toBe(false);
    answerUsername({ username: "deploy", save: false });
    await pending;
  });
});
