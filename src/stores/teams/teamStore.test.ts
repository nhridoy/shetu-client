import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/teams", () => ({
  teamsApi: { listTeams: vi.fn(), createTeam: vi.fn(), listMembers: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockRejectedValue(new Error("no cache")),
}));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "account-1" } }) },
}));

import { teamsApi } from "@/lib/api/teams";
import { useTeamStore } from "./teamStore";

beforeEach(() => {
  vi.mocked(teamsApi.listTeams).mockReset();
  vi.mocked(teamsApi.createTeam).mockReset();
  useTeamStore.setState({
    teams: [],
    selectedTeam: null,
    error: null,
    isLoading: false,
  });
});

describe("team store", () => {
  it("loads server teams into the existing UI model", async () => {
    vi.mocked(teamsApi.listTeams).mockResolvedValue([
      {
        id: "team-1",
        name: "Ops",
        owner_id: "account-1",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ]);
    await useTeamStore.getState().fetchTeams();
    expect(useTeamStore.getState().teams[0]).toMatchObject({
      id: "team-1",
      name: "Ops",
      ownerId: "account-1",
    });
  });

  it("keeps create errors visible and does not add a fake team", async () => {
    vi.mocked(teamsApi.createTeam).mockRejectedValue(
      new Error("server unavailable"),
    );
    await expect(
      useTeamStore.getState().createTeam({ name: "Ops" }),
    ).rejects.toThrow("server unavailable");
    expect(useTeamStore.getState().teams).toEqual([]);
    expect(useTeamStore.getState().error).toBe("server unavailable");
  });
});
