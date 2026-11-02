import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: { getState: () => ({ hosts: [] }) },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import { findLeaf, type LeafNode, useTerminalStore } from "./terminalStore";

const activePane = (tabId: string) => {
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.activePaneId) throw new Error("no active pane");
  return findLeaf(tab.root, tab.activePaneId) as LeafNode;
};

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
});

describe("openConnection", () => {
  it("opens a new active tab when no terminal is open", () => {
    const tabId = useTerminalStore
      .getState()
      .openConnection("h1", "web", { hostAddress: "10.0.0.1" });
    const { tabs, activeTabId } = useTerminalStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).toBe(tabId);
    expect(activePane(tabId)).toMatchObject({ hostId: "h1", hostName: "web" });
  });

  it("fills the active pane when it is still empty", () => {
    const emptyTab = useTerminalStore.getState().addEmptyTab();
    const tabId = useTerminalStore.getState().openConnection("h1", "web");
    expect(tabId).toBe(emptyTab);
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
    expect(activePane(tabId).hostId).toBe("h1");
  });

  it("never replaces a live session; it opens a new tab instead", () => {
    const first = useTerminalStore.getState().openConnection("h1", "web");
    const second = useTerminalStore.getState().openConnection("h2", "db");
    expect(second).not.toBe(first);
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
    expect(activePane(first).hostId).toBe("h1");
    expect(activePane(second).hostId).toBe("h2");
    expect(useTerminalStore.getState().activeTabId).toBe(second);
  });
});
