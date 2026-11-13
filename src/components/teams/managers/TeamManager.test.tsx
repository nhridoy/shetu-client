// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = {
  selectedTeam: null as Record<string, unknown> | null,
};
const noop = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/teams/managers/SharedVaultManager", () => ({
  default: () => null,
}));
vi.mock("@/components/teams/managers/RevokedTeamEditsPanel", () => ({
  default: () => null,
}));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "me", public_key: "" } }),
}));
vi.mock("@/stores/teams/teamStore", () => ({
  useTeamStore: () => ({
    teams: state.selectedTeam ? [state.selectedTeam] : [],
    selectedTeam: state.selectedTeam,
    fetchTeams: noop,
    fetchTeamDetails: noop,
    fetchMyInvites: noop,
    pendingInvites: [],
    error: null,
    isLoading: false,
  }),
}));

import TeamManager from "./TeamManager";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

const team = (extra: Record<string, unknown>) => ({
  id: "t1",
  name: "Ops",
  ownerId: "owner",
  members: [],
  syncStatus: "synced",
  ...extra,
});

function render(t: Record<string, unknown>) {
  state.selectedTeam = t;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<TeamManager />));
  return { container, root };
}

describe("team deletion banner", () => {
  it("banner_shows_for_scheduled_owner", () => {
    const iso = "2026-12-13T12:00:00Z";
    const { container } = render(team({ ownerDeletionScheduledFor: iso }));
    const date = new Date(iso).toLocaleDateString(undefined, {
      dateStyle: "long",
    });
    expect(container.textContent).toContain(
      `This team's owner is deleting their account. The team and its shared vault will be deleted on ${date}.`,
    );
  });

  it("banner_clears_when_owner_cancels", () => {
    const { container, root } = render(
      team({ ownerDeletionScheduledFor: "2026-12-13T12:00:00Z" }),
    );
    state.selectedTeam = team({});
    act(() => root.render(<TeamManager />));
    expect(container.textContent).not.toContain("is deleting their account");
  });

  it("omits the banner for an invalid date or the owner themself", () => {
    expect(
      render(team({ ownerDeletionScheduledFor: "garbage" })).container
        .textContent,
    ).not.toContain("is deleting their account");
    expect(
      render(
        team({
          ownerId: "me",
          ownerDeletionScheduledFor: "2026-12-13T12:00:00Z",
        }),
      ).container.textContent,
    ).not.toContain("is deleting their account");
  });
});
