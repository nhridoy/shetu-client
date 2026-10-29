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
  useAuthStore: {
    getState: () => ({
      user: { id: "owner" },
      localAccessAccountId: "owner",
      serverAuthenticated: true,
      retryServerSession: vi.fn().mockResolvedValue("connected"),
    }),
  },
}));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: { getState: () => ({ fetchVaults: vi.fn() }) },
}));

import { invoke } from "@tauri-apps/api/core";
import { teamsApi } from "@/lib/api/teams";
import { useSharedVaultStore } from "./sharedVaultStore";

const member = {
  userId: "owner",
  publicKey: "pub",
  fingerprint: "fp",
};

const grant = {
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
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useSharedVaultStore.setState({
    sharedVaults: [],
    selectedSharedVault: null,
    error: null,
  });
});

describe("shared vault store", () => {
  it("queues a shared vault with sealed grants for every active member", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([member])
      .mockResolvedValueOnce([grant])
      .mockResolvedValue(undefined);

    await useSharedVaultStore
      .getState()
      .createSharedVault("team", "vault", "Shared");

    const queuedOperation = vi
      .mocked(invoke)
      .mock.calls.find(([command]) => command === "queue_team_operation");
    expect(queuedOperation?.[1]).toEqual(
      expect.objectContaining({
        accountId: "owner",
        operationType: "vault.create",
      }),
    );
    const operationArgs = queuedOperation?.[1] as { payload?: string } | undefined;
    const payload = JSON.parse(operationArgs?.payload ?? "{}");
    expect(payload).toMatchObject({
      vault_id: "vault",
      team_id: "team",
      name: "Shared",
      envelopes: [
        expect.objectContaining({
          recipient_user_id: "owner",
          ciphertext: "ct",
        }),
      ],
    });
    expect(teamsApi.createVault).not.toHaveBeenCalled();
    expect(useSharedVaultStore.getState().sharedVaults).toMatchObject([
      { id: "vault", name: "Shared", rotationState: "ready" },
    ]);
  });

  it("renames a shared vault locally and queues the sync operation", async () => {
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

    await useSharedVaultStore
      .getState()
      .renameSharedVault("team", "vault", "New");

    expect(invoke).toHaveBeenCalledWith(
      "queue_team_operation",
      expect.objectContaining({
        accountId: "owner",
        operationType: "vault.rename",
        payload: JSON.stringify({ vault_id: "vault", name: "New" }),
      }),
    );
    expect(teamsApi.renameVault).not.toHaveBeenCalled();
    expect(useSharedVaultStore.getState().sharedVaults[0].name).toBe("New");
  });

  it("queues a rotation for a vault marked for rotation locally", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([
        {
          id: "vault",
          keyEpoch: 1,
          revision: 3,
          rotationState: "rotation_required",
        },
      ])
      .mockResolvedValue(undefined);
    useSharedVaultStore.setState({
      sharedVaults: [
        {
          id: "vault",
          vaultId: "vault",
          teamId: "team",
          name: "Shared",
          createdAt: "",
          rotationState: "rotation_required",
        },
      ],
    });

    await useSharedVaultStore.getState().rotateSharedVault("team", "vault");

    expect(invoke).toHaveBeenCalledWith(
      "queue_team_operation",
      expect.objectContaining({
        accountId: "owner",
        operationType: "vault.rotate",
        payload: JSON.stringify({ team_id: "team", vault_id: "vault" }),
      }),
    );
    expect(teamsApi.stageRotation).not.toHaveBeenCalled();
    expect(useSharedVaultStore.getState().sharedVaults[0].rotationState).toBe(
      "rotation_pending",
    );
  });

  it("keeps a failed local creation visible without a fake vault", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("offline"));

    await expect(
      useSharedVaultStore
        .getState()
        .createSharedVault("team", "vault", "Shared"),
    ).rejects.toThrow("offline");
    expect(useSharedVaultStore.getState().sharedVaults).toEqual([]);
    expect(useSharedVaultStore.getState().error).toBe("offline");
  });
});
