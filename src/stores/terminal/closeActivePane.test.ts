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

import { useTerminalStore } from "./terminalStore";

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
});

describe("closeActivePane", () => {
  it("closes the focused pane, then the tab, then returns null", () => {
    const store = useTerminalStore.getState();
    const tabA = store.addEmptyTab();
    const tabB = store.addEmptyTab();
    const paneB = useTerminalStore
      .getState()
      .tabs.find((t) => t.id === tabB)?.activePaneId;
    if (!paneB) throw new Error("no pane");
    store.splitPane(tabB, paneB, "horizontal");

    expect(useTerminalStore.getState().closeActivePane()).toBe(tabB);
    expect(useTerminalStore.getState().closeActivePane()).toBe(tabA);
    expect(useTerminalStore.getState().closeActivePane()).toBeNull();
    expect(useTerminalStore.getState().closeActivePane()).toBeNull();
  });
});
