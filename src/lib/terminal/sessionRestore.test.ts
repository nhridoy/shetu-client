import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  fetchHosts: vi.fn(async () => {}),
  hosts: [] as { id: string }[],
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => m.data.get(k),
    set: async (k: string, v: unknown) => void m.data.set(k, v),
    clear: async () => m.data.clear(),
    save: async () => {},
  }),
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: {
    getState: () => ({ hosts: m.hosts, fetchHosts: m.fetchHosts }),
  },
}));
vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import { useTerminalStore } from "@/stores/terminal/terminalStore";
import {
  clearSavedSessions,
  restoreLastSession,
  snapshotSession,
  startSessionPersistence,
} from "./sessionRestore";

const leaf = (hostId: string, hostName: string) => ({
  type: "leaf" as const,
  id: `p-${hostId}`,
  hostId,
  hostName,
  title: hostName,
  connectionStatus: "connected" as const,
  reconnect: null,
  size: 100,
});

const saved = {
  tabs: [
    { title: "web", root: leaf("h1", "web-1") },
    { title: "db", root: leaf("h2", "db-1") },
  ],
  activeIndex: 0,
  workspaceId: "w1",
  workspaceName: "Prod",
};

beforeEach(() => {
  m.data.clear();
  m.hosts = [{ id: "h1" }, { id: "h2" }];
  m.fetchHosts.mockClear();
  useTerminalStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionRestore", () => {
  it("snapshots tabs, the active one and the workspace", () => {
    const store = useTerminalStore.getState();
    store.launchWorkspace({ tabs: saved.tabs as never }, "w1", "Prod");
    const state = useTerminalStore.getState();
    useTerminalStore.setState({ activeTabId: state.tabs[0].id });
    const snap = snapshotSession(useTerminalStore.getState());
    expect(snap.tabs.map((t) => t.title)).toEqual(["web", "db"]);
    expect(snap.activeIndex).toBe(0);
    expect(snap).toMatchObject({ workspaceId: "w1", workspaceName: "Prod" });
    expect(JSON.stringify(snap)).not.toContain('"connected"');
  });

  it("a change persists after 500 ms", async () => {
    vi.useFakeTimers();
    const stop = startSessionPersistence("acct-1");
    useTerminalStore.getState().addEmptyTab();
    expect(m.data.get("last:acct-1")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(
      (m.data.get("last:acct-1") as { tabs: unknown[] }).tabs,
    ).toHaveLength(1);
    stop();
  });

  it("restore reopens tabs and the active one", async () => {
    m.data.set("last:acct-1", { ...saved, activeIndex: 1 });
    expect(await restoreLastSession("acct-1", "v1")).toBe(true);
    const state = useTerminalStore.getState();
    expect(state.tabs.map((t) => t.title)).toEqual(["web", "db"]);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    expect(state.activeWorkspaceId).toBe("w1");
  });

  it("restore skips when tabs are open", async () => {
    m.data.set("last:acct-1", saved);
    useTerminalStore.getState().addEmptyTab();
    expect(await restoreLastSession("acct-1", "v1")).toBe(false);
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
  });

  it("junk saved value is ignored", async () => {
    for (const junk of [null, "x", { tabs: "nope" }, { tabs: [{}] }, 42]) {
      m.data.set("last:acct-1", junk);
      expect(await restoreLastSession("acct-1", "v1")).toBe(false);
      expect(useTerminalStore.getState().tabs).toHaveLength(0);
    }
  });

  it("layouts are per account", async () => {
    m.data.set("last:acct-1", saved);
    expect(await restoreLastSession("acct-2", "v1")).toBe(false);
  });

  it("restore waits for hosts", async () => {
    m.data.set("last:acct-1", saved);
    m.hosts = [];
    m.fetchHosts.mockImplementationOnce(async () => {
      m.hosts = [{ id: "h1" }, { id: "h2" }];
    });
    await restoreLastSession("acct-1", "v1");
    expect(m.fetchHosts).toHaveBeenCalledWith("v1");
    const titles = useTerminalStore
      .getState()
      .tabs.map((t) => (t.root as { hostName?: string }).hostName);
    expect(titles).toEqual(["web-1", "db-1"]);
  });

  it("clear empties the store", async () => {
    m.data.set("last:acct-1", saved);
    await clearSavedSessions();
    expect(m.data.size).toBe(0);
  });
});
