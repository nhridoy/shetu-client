import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { subscribe: vi.fn() },
}));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: {
    getState: () => ({ vaults: [{ id: "v1", isDefault: true }] }),
  },
}));

import { useSessionStore } from "./sessionStore";

describe("session history store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessionStore.setState({
      sessions: [],
      selectedSession: null,
      output: "",
      error: null,
    });
  });

  it("loads encrypted history through Rust and deletes a selected attempt", async () => {
    const item = {
      id: "s1",
      vault_id: "v1",
      host_id: "h1",
      host_label: "Host",
      connection_type: "ssh" as const,
      state: "ended" as const,
      started_at: "2026-10-02T00:00:00.000Z",
      connected_at: null,
      ended_at: "2026-10-02T00:01:00.000Z",
      reason: null,
      recording: false,
      truncated: false,
    };
    invoke.mockImplementation(async (command: string) =>
      command === "history_list" ? [item] : undefined,
    );
    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions).toEqual([item]);
    useSessionStore.getState().selectSession(item);
    await useSessionStore.getState().deleteSession("s1");
    expect(invoke).toHaveBeenCalledWith("history_delete", {
      vaultId: "v1",
      attemptId: "s1",
    });
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().selectedSession).toBeNull();
  });

  it("loads and updates the encrypted account retention choice", async () => {
    let retentionDays = 30;
    invoke.mockImplementation(async (command: string) => {
      if (command === "history_get_retention") return retentionDays;
      if (command === "history_set_retention") {
        retentionDays = 7;
        return undefined;
      }
      if (command === "history_list") return [];
      return undefined;
    });
    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().retentionDays).toBe(30);
    await useSessionStore.getState().setRetentionDays(7);
    expect(invoke).toHaveBeenCalledWith("history_set_retention", {
      vaultId: "v1",
      days: 7,
    });
    expect(useSessionStore.getState().retentionDays).toBe(7);
  });
});
