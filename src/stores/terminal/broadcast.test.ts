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

import { findAllLeaves } from "@/lib/common/treeUtils";
import {
  broadcastTargets,
  type LeafNode,
  type TerminalTab,
  useTerminalStore,
} from "./terminalStore";

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
});

/** A tab split into three panes, all connected. */
function threePaneTab() {
  const store = useTerminalStore.getState();
  const tabId = store.addEmptyTab();
  const first = useTerminalStore.getState().tabs.find((t) => t.id === tabId)
    ?.activePaneId as string;
  store.splitPane(tabId, first, "horizontal");
  store.splitPane(tabId, first, "vertical");
  const tab = () =>
    useTerminalStore.getState().tabs.find((t) => t.id === tabId) as TerminalTab;
  const ids = findAllLeaves(tab().root).map((l: LeafNode) => l.id);
  for (const id of ids)
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, id, "connected");
  return { tabId, tab, ids };
}

describe("broadcast", () => {
  it("toggleBroadcast flips one tab", () => {
    const { tabId, tab } = threePaneTab();
    const other = useTerminalStore.getState().addEmptyTab();
    useTerminalStore.getState().toggleBroadcast(tabId);
    expect(tab().broadcast).toBe(true);
    expect(
      useTerminalStore.getState().tabs.find((t) => t.id === other)?.broadcast,
    ).toBeFalsy();
    useTerminalStore.getState().toggleBroadcast(tabId);
    expect(tab().broadcast).toBe(false);
  });

  it("targets exclude the source and are empty while off", () => {
    const { tabId, tab, ids } = threePaneTab();
    expect(broadcastTargets(tab(), ids[0])).toEqual([]);
    useTerminalStore.getState().toggleBroadcast(tabId);
    expect(broadcastTargets(tab(), ids[0]).sort()).toEqual(
      [ids[1], ids[2]].sort(),
    );
  });

  it("only connected panes receive", () => {
    const { tabId, tab, ids } = threePaneTab();
    useTerminalStore.getState().toggleBroadcast(tabId);
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, ids[2], "reconnecting");
    expect(broadcastTargets(tab(), ids[0])).toEqual([ids[1]]);
  });

  it("a pane that connects mid-broadcast waits until panes are synced", () => {
    const { tabId, tab, ids } = threePaneTab();
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, ids[2], "connecting");
    useTerminalStore.getState().toggleBroadcast(tabId);
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, ids[2], "connected");
    expect(broadcastTargets(tab(), ids[0])).toEqual([ids[1]]);
    useTerminalStore.getState().syncBroadcastPanes(tabId);
    expect(broadcastTargets(tab(), ids[0]).sort()).toEqual(
      [ids[1], ids[2]].sort(),
    );
  });

  it("targets follow the tree", () => {
    const { tabId, tab, ids } = threePaneTab();
    useTerminalStore.getState().toggleBroadcast(tabId);
    useTerminalStore.getState().removePane(tabId, ids[1]);
    expect(broadcastTargets(tab(), ids[0])).toEqual([ids[2]]);
  });
});
