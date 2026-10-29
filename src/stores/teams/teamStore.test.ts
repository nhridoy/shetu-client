import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/teams", () => ({
  teamsApi: { listTeams: vi.fn(), createTeam: vi.fn(), listMembers: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({
      user: { id: "account-1" },
      retryServerSession: vi.fn().mockResolvedValue("connected"),
    }),
  },
}));

import { teamsApi } from "@/lib/api/teams";
import { invoke } from "@tauri-apps/api/core";
import { useTeamStore } from "./teamStore";

beforeEach(() => {
  vi.mocked(teamsApi.listTeams).mockReset();
  vi.mocked(teamsApi.createTeam).mockReset();
  vi.mocked(invoke).mockReset();
  useTeamStore.setState({
    teams: [],
    selectedTeam: null,
    error: null,
    isLoading: false,
  });
});

describe("team store", () => {
  it("loads teams from local SQLite without calling the server API", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "team-1",
        name: "Ops",
        ownerId: "account-1",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    await useTeamStore.getState().fetchTeams();
    expect(invoke).toHaveBeenCalledWith("local_teams", {
      accountId: "account-1",
    });
    expect(teamsApi.listTeams).not.toHaveBeenCalled();
    expect(useTeamStore.getState().teams[0]).toMatchObject({
      id: "team-1",
      name: "Ops",
      ownerId: "account-1",
    });
  });

  it("keeps create errors visible and does not add a fake team", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("local database unavailable"));
    await expect(
      useTeamStore.getState().createTeam({ name: "Ops" }),
    ).rejects.toThrow("local database unavailable");
    expect(invoke).toHaveBeenCalledWith(
      "queue_team_operation",
      expect.objectContaining({
        accountId: "account-1",
        operationType: "team.create",
      }),
    );
    expect(teamsApi.createTeam).not.toHaveBeenCalled();
    expect(useTeamStore.getState().teams).toEqual([]);
    expect(useTeamStore.getState().error).toBe("local database unavailable");
  });
});
