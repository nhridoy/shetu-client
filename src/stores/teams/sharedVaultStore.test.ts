import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/teams", () => ({
  teamsApi: {
    listVaults: vi.fn(),
    listMembers: vi.fn(),
    createVault: vi.fn(),
    renameVault: vi.fn(),
    keyEnvelope: vi.fn(),
    rotationSnapshot: vi.fn(),
    stageRotation: vi.fn(),
    commitRotation: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockRejectedValue(new Error("no cache")),
}));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "owner" } }) },
}));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: { getState: () => ({ fetchVaults: vi.fn() }) },
}));

import { invoke } from "@tauri-apps/api/core";
import { teamsApi } from "@/lib/api/teams";
import { useSharedVaultStore } from "./sharedVaultStore";

beforeEach(() => {
  vi.mocked(teamsApi.listMembers).mockReset();
  vi.mocked(teamsApi.createVault).mockReset();
  vi.mocked(invoke).mockReset();
  useSharedVaultStore.setState({
    sharedVaults: [],
    selectedSharedVault: null,
    error: null,
  });
});

describe("shared vault store", () => {
  it("requires a sealed grant for every active member before server creation", async () => {
    vi.mocked(teamsApi.listMembers).mockResolvedValue([
      {
        id: "m1",
        user_id: "owner",
        email: "owner@example.com",
        username: "Owner",
        role: "owner",
        joined_at: "",
        public_key: "pub",
        fingerprint: "fp",
      },
    ]);
    vi.mocked(invoke).mockResolvedValue([
      {
        version: 1,
        context: {
          team_id: "team",
          vault_id: "vault",
          epoch: 1,
          recipient_user_id: "owner",
          recipient_fingerprint: "fp",
        },
        ephemeral_public_key: "epk",
        nonce: "nonce",
        ciphertext: "ct",
      },
    ]);
    vi.mocked(teamsApi.createVault).mockResolvedValue({
      id: "vault",
      team_id: "team",
      owner_id: "owner",
      kind: "team",
      name: "Shared",
      key_epoch: 1,
      revision: 1,
      rotation_state: "ready",
      created_at: "",
      updated_at: "",
    });
    await useSharedVaultStore
      .getState()
      .createSharedVault("team", "vault", "Shared");
    expect(teamsApi.createVault).toHaveBeenCalledWith(
      "team",
      expect.objectContaining({
        id: "vault",
        envelopes: [
          expect.objectContaining({
            recipient_user_id: "owner",
            ciphertext: "ct",
          }),
        ],
      }),
    );
  });

  it("recovers a created vault when the server response is lost", async () => {
    vi.mocked(teamsApi.listMembers).mockResolvedValue([
      {
        id: "m1",
        user_id: "owner",
        email: "owner@example.com",
        username: "Owner",
        role: "owner",
        joined_at: "",
        public_key: "pub",
        fingerprint: "fp",
      },
    ]);
    vi.mocked(invoke).mockResolvedValue([
      {
        version: 1,
        context: {
          team_id: "team",
          vault_id: "vault",
          epoch: 1,
          recipient_user_id: "owner",
          recipient_fingerprint: "fp",
        },
        ephemeral_public_key: "epk",
        nonce: "nonce",
        ciphertext: "ct",
      },
    ]);
    vi.mocked(teamsApi.createVault).mockRejectedValue(
      new Error("response lost"),
    );
    vi.mocked(teamsApi.listVaults).mockResolvedValue([
      {
        id: "vault",
        team_id: "team",
        owner_id: "owner",
        kind: "team",
        name: "Shared",
        key_epoch: 1,
        revision: 1,
        rotation_state: "ready",
        created_at: "",
        updated_at: "",
      },
    ]);
    await useSharedVaultStore
      .getState()
      .createSharedVault("team", "vault", "Shared");
    expect(
      useSharedVaultStore.getState().sharedVaults.map((vault) => vault.id),
    ).toEqual(["vault"]);
  });

  it("renames a shared vault through the team endpoint and refreshes its local label", async () => {
    useSharedVaultStore.setState({
      sharedVaults: [
        {
          id: "vault",
          vaultId: "vault",
          teamId: "team",
          name: "Old",
          createdAt: "",
          rotationState: "ready",
        },
      ],
    });
    vi.mocked(teamsApi.renameVault).mockResolvedValue({
      id: "vault",
      team_id: "team",
      owner_id: "owner",
      kind: "team",
      name: "New",
      key_epoch: 1,
      revision: 2,
      rotation_state: "ready",
      created_at: "",
      updated_at: "",
    });
    await useSharedVaultStore
      .getState()
      .renameSharedVault("team", "vault", "New");
    expect(teamsApi.renameVault).toHaveBeenCalledWith("team", "vault", "New");
    expect(invoke).toHaveBeenCalledWith(
      "cache_team_vault_metadata",
      expect.objectContaining({
        vaultId: "vault",
        name: "New",
        epoch: 1,
      }),
    );
    expect(useSharedVaultStore.getState().sharedVaults[0].name).toBe("New");
  });

  it("stages only encrypted rows and commits a required rotation", async () => {
    const vault = {
      id: "vault",
      team_id: "team",
      owner_id: "owner",
      kind: "team" as const,
      name: "Shared",
      key_epoch: 1,
      revision: 3,
      rotation_state: "rotation_required",
      created_at: "",
      updated_at: "",
    };
    vi.mocked(teamsApi.listVaults).mockResolvedValue([vault]);
    vi.mocked(teamsApi.listMembers).mockResolvedValue([
      {
        id: "m1",
        user_id: "owner",
        email: "owner@example.com",
        username: "Owner",
        role: "owner",
        joined_at: "",
        public_key: "pub",
        fingerprint: "fp",
      },
    ]);
    vi.mocked(teamsApi.rotationSnapshot).mockResolvedValue({
      vault_id: "vault",
      team_id: "team",
      epoch: 1,
      revision: 3,
      rows: [
        { table: "hosts", id: "host", revision: 2, data: "old-ciphertext" },
      ],
      next: "",
      has_more: false,
    });
    vi.mocked(invoke).mockResolvedValue({
      operation_id: "op",
      expected_epoch: 1,
      expected_revision: 3,
      rows: [
        { table: "hosts", id: "host", revision: 2, data: "new-ciphertext" },
      ],
      envelopes: [
        {
          version: 1,
          context: {
            team_id: "team",
            vault_id: "vault",
            epoch: 2,
            recipient_user_id: "owner",
            recipient_fingerprint: "fp",
          },
          ephemeral_public_key: "epk",
          nonce: "nonce",
          ciphertext: "sealed",
        },
      ],
    });
    useSharedVaultStore.setState({
      fetchSharedVaults: vi.fn().mockResolvedValue(undefined),
    });
    await useSharedVaultStore.getState().rotateSharedVault("team", "vault");
    expect(teamsApi.stageRotation).toHaveBeenCalledWith(
      "vault",
      expect.objectContaining({
        operation_id: "op",
        rows: [expect.objectContaining({ data: "new-ciphertext" })],
        envelopes: [expect.objectContaining({ ciphertext: "sealed" })],
      }),
    );
    expect(teamsApi.commitRotation).toHaveBeenCalledWith("vault", "op");
    expect(
      JSON.stringify(vi.mocked(teamsApi.stageRotation).mock.calls),
    ).not.toContain("old-ciphertext");
  });

  it("keeps a failed creation visible without a fake vault", async () => {
    vi.mocked(teamsApi.listMembers).mockRejectedValue(new Error("offline"));
    await expect(
      useSharedVaultStore
        .getState()
        .createSharedVault("team", "vault", "Shared"),
    ).rejects.toThrow("offline");
    expect(useSharedVaultStore.getState().sharedVaults).toEqual([]);
    expect(useSharedVaultStore.getState().error).toBe("offline");
  });
});
