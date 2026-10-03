import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: {
    getState: () => ({ hosts: [{ id: "host-1", name: "Server" }] }),
  },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import { useTabGroupStore } from "@/stores/sessions/tabGroupStore";
import { useWorkspaceStore } from "@/stores/workspaces/workspaceStore";
import {
  computeTabSnapshot,
  serializeWorkspaceLayout,
  useTerminalStore,
  workspaceLayoutSnapshot,
} from "./terminalStore";

const presetUpdate = vi.fn();
const workspaceCreate = vi.fn();
const workspaceUpdate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTabGroupStore.getState).mockReturnValue({
    updateTabGroup: presetUpdate,
  } as unknown as ReturnType<typeof useTabGroupStore.getState>);
  vi.mocked(useWorkspaceStore.getState).mockReturnValue({
    createWorkspace: workspaceCreate,
    updateWorkspace: workspaceUpdate,
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>);
  presetUpdate.mockResolvedValue(undefined);
  workspaceUpdate.mockResolvedValue(undefined);
  workspaceCreate.mockResolvedValue({ id: "w1", name: "Operations" });
  useTerminalStore.setState({
    tabs: [],
    activeTabId: null,
    activeWorkspaceId: null,
    activeWorkspaceName: null,
    isDirty: false,
    savedSnapshot: "",
  });
});

describe("saved terminal layouts", () => {
  it("rejects an empty workspace instead of saving an unusable record", async () => {
    await expect(
      useTerminalStore.getState().saveAsNewWorkspace("Empty", "v1"),
    ).rejects.toThrow("Open a terminal tab");
    expect(workspaceCreate).not.toHaveBeenCalled();
  });

  it("serializes connection references without live state or stale SSH addresses", () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    const paneId = useTerminalStore.getState().tabs[0].activePaneId;
    if (!paneId) throw new Error("missing pane");
    useTerminalStore.getState().connectPane(tabId, paneId, "host-1", "Server", {
      hostAddress: "192.0.2.1",
      hostPort: 22,
      hostUsername: "root",
    });
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    const saved = serializeWorkspaceLayout(useTerminalStore.getState().tabs);
    const leaf = saved.tabs[0].root;
    expect(leaf).toMatchObject({
      hostId: "host-1",
      connectionStatus: "disconnected",
      reconnect: null,
    });
    expect(leaf).not.toHaveProperty("hostAddress");
    expect(leaf).not.toHaveProperty("hostUsername");
  });

  it("does not mark a preset changed when only connection status changes", () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    const paneId = useTerminalStore.getState().tabs[0].activePaneId;
    if (!paneId) throw new Error("missing pane");
    useTerminalStore.getState().setPresetForTab(tabId, "p1", "Starter");
    const saved = useTerminalStore.getState().tabs[0].savedPresetSnapshot;
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    expect(computeTabSnapshot(useTerminalStore.getState().tabs[0].root)).toBe(
      saved,
    );
  });

  it("restores a missing saved host as an empty pane instead of dialing a stale address", () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    const paneId = useTerminalStore.getState().tabs[0].activePaneId;
    if (!paneId) throw new Error("missing pane");
    useTerminalStore.getState().restorePreset(
      {
        id: "p1",
        name: "Missing",
        layout: JSON.stringify({
          type: "leaf",
          id: "old",
          hostId: "deleted-host",
          hostName: "Deleted",
          hostAddress: "192.0.2.55",
          title: "Deleted",
          connectionStatus: "connected",
          reconnect: null,
          size: 100,
        }),
      },
      tabId,
    );
    const restored = useTerminalStore.getState().tabs[0].root;
    expect(restored).toMatchObject({
      type: "leaf",
      hostId: undefined,
      hostName: "Missing host: Deleted",
      connectionStatus: "disconnected",
    });
    expect(restored.id).not.toBe("old");
  });

  it("persists preset changes before marking the tab clean", async () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    useTerminalStore.getState().setPresetForTab(tabId, "p1", "Starter");
    await useTerminalStore.getState().saveCurrentPreset(tabId);
    expect(presetUpdate).toHaveBeenCalledWith(
      "p1",
      useTerminalStore.getState().tabs[0].root,
    );
    expect(useTerminalStore.getState().tabs[0].savedPresetSnapshot).toBe(
      JSON.stringify(useTerminalStore.getState().tabs[0].root),
    );
  });

  it("does not mark a preset clean when its encrypted write fails", async () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    useTerminalStore.getState().setPresetForTab(tabId, "p1", "Starter");
    const originalSnapshot =
      useTerminalStore.getState().tabs[0].savedPresetSnapshot;
    const paneId = useTerminalStore.getState().tabs[0].activePaneId;
    if (!paneId) throw new Error("missing pane");
    useTerminalStore.getState().splitPane(tabId, paneId, "horizontal");
    presetUpdate.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      useTerminalStore.getState().saveCurrentPreset(tabId),
    ).rejects.toThrow("disk full");
    expect(useTerminalStore.getState().tabs[0].savedPresetSnapshot).toBe(
      originalSnapshot,
    );
  });

  it("creates and updates a workspace through encrypted rows", async () => {
    useTerminalStore.getState().addEmptyTab();
    await useTerminalStore.getState().saveAsNewWorkspace("Operations", "v1");
    expect(workspaceCreate).toHaveBeenCalledWith(
      "Operations",
      expect.objectContaining({ tabs: expect.any(Array) }),
      "v1",
    );
    expect(useTerminalStore.getState().activeWorkspaceId).toBe("w1");
    await useTerminalStore.getState().saveCurrentWorkspace();
    expect(workspaceUpdate).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ tabs: expect.any(Array) }),
    );
  });

  it("detects workspace layout edits while ignoring live connection status", async () => {
    const tabId = useTerminalStore.getState().addEmptyTab();
    await useTerminalStore.getState().saveAsNewWorkspace("Operations", "v1");
    const saved = useTerminalStore.getState().savedSnapshot;
    const paneId = useTerminalStore.getState().tabs[0].activePaneId;
    if (!paneId) throw new Error("missing pane");
    useTerminalStore
      .getState()
      .updatePaneConnectionStatus(tabId, paneId, "connected");
    expect(workspaceLayoutSnapshot(useTerminalStore.getState().tabs)).toBe(
      saved,
    );
    useTerminalStore.getState().splitPane(tabId, paneId, "vertical");
    expect(workspaceLayoutSnapshot(useTerminalStore.getState().tabs)).not.toBe(
      saved,
    );
  });
});
