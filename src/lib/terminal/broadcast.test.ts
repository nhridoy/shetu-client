// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: m.warning } }));
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
import { toggleTabBroadcast } from "./broadcast";

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
  m.warning.mockClear();
});

function tabWith(local: boolean) {
  const store = useTerminalStore.getState();
  const tabId = store.addEmptyTab();
  const pane = useTerminalStore.getState().tabs[0].activePaneId as string;
  useTerminalStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({
      ...t,
      root: { ...t.root, connectionType: local ? "local" : "ssh" } as never,
    })),
  }));
  return { tabId, pane };
}

describe("toggleTabBroadcast", () => {
  it("warns when turning on in a tab with local shells", () => {
    const { tabId } = tabWith(true);
    toggleTabBroadcast(tabId);
    expect(m.warning).toHaveBeenCalledWith(
      "Broadcast includes 1 local shell on this computer",
    );
    toggleTabBroadcast(tabId);
    expect(m.warning).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for SSH-only tabs", () => {
    const { tabId } = tabWith(false);
    toggleTabBroadcast(tabId);
    expect(m.warning).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs[0].broadcast).toBe(true);
  });
});
