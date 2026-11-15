import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ insert: vi.fn(() => "ok") }));
vi.mock("./sessionManager", () => ({ insertIntoPane: m.insert }));
vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: { getState: () => ({ hosts: [] }) },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { runWhenConnected } from "./runWhenConnected";

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
  m.insert.mockClear();
});
afterEach(() => vi.useRealTimers());

function newTab() {
  useTerminalStore.getState().addTab("h1", "web-1");
  const tab = useTerminalStore.getState().tabs[0];
  return { tabId: tab.id, paneId: tab.activePaneId as string };
}

describe("runWhenConnected", () => {
  it("runs once when the pane connects", () => {
    const { tabId, paneId } = newTab();
    runWhenConnected(tabId, paneId, "uptime");
    expect(m.insert).not.toHaveBeenCalled();
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "reconnecting");
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    expect(m.insert).toHaveBeenCalledTimes(1);
    expect(m.insert).toHaveBeenCalledWith(paneId, "uptime", true);
  });

  it("closed pane never receives", () => {
    const { tabId, paneId } = newTab();
    runWhenConnected(tabId, paneId, "uptime");
    useTerminalStore.getState().removeTab(tabId);
    useTerminalStore.getState().addTab("h1", "web-1");
    useTerminalStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, id: tabId })),
    }));
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("a failed connection stops waiting", () => {
    const { tabId, paneId } = newTab();
    runWhenConnected(tabId, paneId, "uptime");
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "failed");
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("gives up after two minutes", () => {
    vi.useFakeTimers();
    const { tabId, paneId } = newTab();
    runWhenConnected(tabId, paneId, "uptime");
    vi.advanceTimersByTime(120_000);
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    expect(m.insert).not.toHaveBeenCalled();
  });
});
