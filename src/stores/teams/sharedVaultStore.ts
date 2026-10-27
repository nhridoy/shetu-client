import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth/authStore";
import { notifyTeamMutation } from "@/stores/sync/syncStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { toServerEnvelope } from "./teamStore";

export interface SharedVault {
  id: string;
  name: string;
  teamId: string;
  vaultId: string;
  createdAt: string;
  rotationState: string;
  keyEpoch?: number;
  revision?: number;
}

interface TauriEnvelope {
  version: number;
  context: {
    team_id: string;
    vault_id: string;
    epoch: number;
    recipient_user_id: string;
    recipient_fingerprint: string;
  };
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
interface SharedVaultState {
  sharedVaults: SharedVault[];
  selectedSharedVault: SharedVault | null;
  isLoading: boolean;
  error: string | null;
  fetchSharedVaults: (teamId: string) => Promise<void>;
  createSharedVault: (
    teamId: string,
    vaultId: string,
    name?: string,
  ) => Promise<void>;
  renameSharedVault: (
    teamId: string,
    vaultId: string,
    name: string,
  ) => Promise<void>;
  deleteSharedVault: (teamId: string, vaultId: string) => Promise<void>;
  rotateSharedVault: (teamId: string, vaultId: string) => Promise<void>;
  selectSharedVault: (vault: SharedVault | null) => void;
  clearError: () => void;
  reset: () => void;
}

export const useSharedVaultStore = create<SharedVaultState>((set, get) => ({
  sharedVaults: [],
  selectedSharedVault: null,
  isLoading: false,
  error: null,
  fetchSharedVaults: async (teamId) => {
    set({ isLoading: true, error: null });
    try {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) throw new Error("Sign in to access team vaults.");
      const vaults = await invoke<
        Array<{
          id: string;
          teamId: string;
          name: string;
          createdAt: string;
          rotationState: string;
          keyEpoch: number;
          revision: number;
        }>
      >("local_team_vaults", { accountId: userId, teamId });
      const sharedVaults = vaults.map((vault) => ({
        id: vault.id,
        vaultId: vault.id,
        teamId: vault.teamId,
        name: vault.name,
        createdAt: vault.createdAt,
        rotationState: vault.rotationState,
        keyEpoch: vault.keyEpoch,
        revision: vault.revision,
      }));
      set({
        sharedVaults,
        selectedSharedVault:
          sharedVaults.find(
            (vault) => vault.id === get().selectedSharedVault?.id,
          ) ??
          sharedVaults[0] ??
          null,
        isLoading: false,
      });
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({
        error: errorText(error),
        isLoading: false,
      });
    }
  },
  createSharedVault: async (teamId, vaultId, name) => {
    set({ isLoading: true, error: null });
    try {
      const id = vaultId || crypto.randomUUID();
      const vaultName = name?.trim() || "Shared vault";
      const accountId = useAuthStore.getState().user?.id;
      if (!accountId) throw new Error("Sign in to create a team vault.");
      const members = await invoke<
        Array<{
          userId: string;
          publicKey: string;
          fingerprint: string;
        }>
      >("local_team_members", { accountId, teamId });
      if (
        members.length === 0 ||
        members.some((member) => !member.publicKey || !member.fingerprint)
      ) {
        throw new Error(
          "Every active member needs an identity key before creating a shared vault.",
        );
      }
      const recipients = members.map((member) => ({
        user_id: member.userId,
        public_key: member.publicKey,
        fingerprint: member.fingerprint,
      }));
      const grants = await invoke<TauriEnvelope[]>("create_team_vault_key", {
        vaultId: id,
        teamId,
        recipients,
      });
      if (grants.length !== recipients.length)
        throw new Error("Some member key grants were not created.");
      await invoke("queue_team_operation", {
        accountId,
        operationType: "vault.create",
        payload: JSON.stringify({
          vault_id: id,
          team_id: teamId,
          name: vaultName,
          envelopes: grants.map(toServerEnvelope),
        }),
      });
      notifyTeamMutation();
      const shared: SharedVault = {
        id,
        vaultId: id,
        teamId,
        name: vaultName,
        createdAt: new Date().toISOString(),
        rotationState: "ready",
        keyEpoch: 1,
        revision: 1,
      };
      const sharedVaults = [...get().sharedVaults, shared];
      set({ sharedVaults, selectedSharedVault: shared, isLoading: false });
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  renameSharedVault: async (_teamId, vaultId, name) => {
    set({ isLoading: true, error: null });
    try {
      const accountId = useAuthStore.getState().user?.id;
      if (!accountId) throw new Error("Sign in to rename a team vault.");
      await invoke("queue_team_operation", {
        accountId,
        operationType: "vault.rename",
        payload: JSON.stringify({ vault_id: vaultId, name: name.trim() }),
      });
      notifyTeamMutation();
      const existing = get().sharedVaults.find((vault) => vault.id === vaultId);
      if (!existing) throw new Error("Team vault not found locally.");
      const renamed = { ...existing, name: name.trim() };
      const sharedVaults = get().sharedVaults.map((vault) =>
        vault.id === vaultId ? renamed : vault,
      );
      set({
        sharedVaults,
        selectedSharedVault:
          get().selectedSharedVault?.id === vaultId
            ? renamed
            : get().selectedSharedVault,
        isLoading: false,
      });
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  deleteSharedVault: async (_teamId, vaultId) => {
    set({ isLoading: true, error: null });
    try {
      const accountId = useAuthStore.getState().user?.id;
      if (!accountId) throw new Error("Sign in to delete a team vault.");
      await invoke("queue_team_operation", {
        accountId,
        operationType: "vault.delete",
        payload: JSON.stringify({ vault_id: vaultId }),
      });
      notifyTeamMutation();
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
    const sharedVaults = get().sharedVaults.filter(
      (vault) => vault.id !== vaultId,
    );
    set({
      sharedVaults,
      selectedSharedVault:
        get().selectedSharedVault?.id === vaultId
          ? (sharedVaults[0] ?? null)
          : get().selectedSharedVault,
      isLoading: false,
    });
    await useVaultStore.getState().fetchVaults();
  },
  rotateSharedVault: async (teamId, vaultId) => {
    set({ isLoading: true, error: null });
    try {
      const accountId = useAuthStore.getState().user?.id;
      if (!accountId) throw new Error("Sign in to rotate a team vault.");
      const vaults = await invoke<
        Array<{
          id: string;
          keyEpoch: number;
          revision: number;
          rotationState: string;
        }>
      >("local_team_vaults", { accountId, teamId });
      const vault = vaults.find((item) => item.id === vaultId);
      if (vault?.rotationState !== "rotation_required") {
        throw new Error("This shared vault no longer needs rotation.");
      }
      await invoke("queue_team_operation", {
        accountId,
        operationType: "vault.rotate",
        payload: JSON.stringify({ team_id: teamId, vault_id: vaultId }),
      });
      notifyTeamMutation();
      const sharedVaults = get().sharedVaults.map((item) =>
        item.id === vaultId
          ? { ...item, rotationState: "rotation_pending" }
          : item,
      );
      const selectedSharedVault =
        sharedVaults.find((item) => item.id === vaultId) ?? null;
      set({ sharedVaults, selectedSharedVault, isLoading: false });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  selectSharedVault: (vault) => set({ selectedSharedVault: vault }),
  clearError: () => set({ error: null }),
  reset: () =>
    set({
      sharedVaults: [],
      selectedSharedVault: null,
      isLoading: false,
      error: null,
    }),
}));
