import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  fetchHosts: vi.fn(async () => {}),
  hosts: [] as { id: string }[],
  destroySession: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => m.data.get(k),
    set: async (k: string, v: unknown) => void m.data.set(k, v),
    clear: async () => m.data.clear(),
    save: async () => {},
  }),
}));
vi.mock("./sessionManager", () => ({ destroySession: m.destroySession }));
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
  endAllSessions,
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

  it("a missing host keeps its id and name when saved again", async () => {
    m.data.set("last:acct-1", saved);
    m.hosts = [];
    await restoreLastSession("acct-1", "v1");
    const leafOf = (t: { root: unknown }) =>
      t.root as { hostId?: string; hostName: string };
    // Shown as missing for now…
    expect(leafOf(useTerminalStore.getState().tabs[0]).hostName).toContain(
      "Missing host",
    );
    // …but saved with the original host, so it comes back once the host is there.
    const snap = snapshotSession(useTerminalStore.getState());
    expect(
      snap.tabs.map((t) => [leafOf(t).hostId, leafOf(t).hostName]),
    ).toEqual([
      ["h1", "web-1"],
      ["h2", "db-1"],
    ]);
  });

  it("malformed panes are dropped instead of reaching the UI", async () => {
    m.data.set("last:acct-1", {
      tabs: [
        { title: "bad name", root: { ...leaf("h1", "x"), hostName: {} } },
        { title: "empty split", root: { type: "split", children: [] } },
        { title: "ok", root: leaf("h2", "db-1") },
      ],
      activeIndex: 0,
    });
    await restoreLastSession("acct-1", "v1");
    expect(useTerminalStore.getState().tabs.map((t) => t.title)).toEqual([
      "ok",
    ]);
  });

  it("renaming the workspace is saved", async () => {
    vi.useFakeTimers();
    const stop = startSessionPersistence("acct-1");
    useTerminalStore.setState({ activeWorkspaceName: "Renamed" });
    await vi.advanceTimersByTimeAsync(500);
    expect(
      (m.data.get("last:acct-1") as { workspaceName: string }).workspaceName,
    ).toBe("Renamed");
    stop();
  });

  it("endAllSessions closes tabs, ends their sessions and clears the file", async () => {
    m.data.set("last:acct-1", saved);
    await restoreLastSession("acct-1", "v1");
    const panes = useTerminalStore.getState().tabs.map((t) => t.root.id);
    await endAllSessions();
    expect(useTerminalStore.getState().tabs).toEqual([]);
    for (const id of panes) expect(m.destroySession).toHaveBeenCalledWith(id);
    expect(m.data.size).toBe(0);
  });

  it("clear empties the store", async () => {
    m.data.set("last:acct-1", saved);
    await clearSavedSessions();
    expect(m.data.size).toBe(0);
  });
});
