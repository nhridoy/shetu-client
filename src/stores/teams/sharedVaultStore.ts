import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  type RotationRowDto,
  type TeamVaultDto,
  teamsApi,
} from "@/lib/api/teams";
import { useAuthStore } from "@/stores/auth/authStore";
import { TEAM_ACCESS_REVOKED_EVENT } from "@/stores/sync/syncStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { toServerEnvelope } from "./teamStore";

export interface SharedVault {
  id: string;
  name: string;
  teamId: string;
  vaultId: string;
  createdAt: string;
  rotationState: string;
}

interface PreparedRotation {
  operation_id: string;
  expected_epoch: number;
  expected_revision: number;
  rows: RotationRowDto[];
  envelopes: TauriEnvelope[];
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

const toSharedVault = (vault: TeamVaultDto): SharedVault => ({
  id: vault.id,
  vaultId: vault.id,
  teamId: vault.team_id,
  name: vault.name,
  createdAt: vault.created_at,
  rotationState: vault.rotation_state,
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const cacheKey = (teamId: string) =>
  `vaults:${useAuthStore.getState().user?.id ?? ""}:${teamId}`;
async function saveCache(teamId: string, vaults: SharedVault[]): Promise<void> {
  try {
    const store = await load("team-cache.json", { autoSave: false });
    await store.set(cacheKey(teamId), vaults);
    await store.save();
  } catch {
    /* Insensitive metadata is best-effort. */
  }
}
async function readCache(teamId: string): Promise<SharedVault[]> {
  try {
    const store = await load("team-cache.json", { autoSave: false });
    return (await store.get<SharedVault[]>(cacheKey(teamId))) ?? [];
  } catch {
    return [];
  }
}

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
      const vaults = await teamsApi.listVaults(teamId);
      const userId = useAuthStore.getState().user?.id;
      if (!userId) throw new Error("Sign in to access team vaults.");
      for (const vault of vaults) {
        const envelope = await teamsApi.keyEnvelope(vault.id);
        await invoke("import_team_key_envelope", {
          userId,
          envelope: {
            version: envelope.version,
            context: {
              team_id: envelope.team_id,
              vault_id: envelope.vault_id,
              epoch: envelope.epoch,
              recipient_user_id: envelope.recipient_user_id,
              recipient_fingerprint: envelope.recipient_fingerprint,
            },
            ephemeral_public_key: envelope.ephemeral_public_key,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
          },
        });
        await invoke("cache_team_vault_metadata", {
          vaultId: vault.id,
          teamId,
          ownerId: vault.owner_id,
          name: vault.name,
          epoch: vault.key_epoch,
          rotationState: vault.rotation_state,
        });
      }
      const sharedVaults = vaults.map(toSharedVault);
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
      await saveCache(teamId, sharedVaults);
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      const cached = await readCache(teamId);
      set({
        sharedVaults: cached,
        selectedSharedVault:
          cached.find((vault) => vault.id === get().selectedSharedVault?.id) ??
          cached[0] ??
          null,
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
      const members = await teamsApi.listMembers(teamId);
      if (
        members.length === 0 ||
        members.some((member) => !member.public_key || !member.fingerprint)
      ) {
        throw new Error(
          "Every active member needs an identity key before creating a shared vault.",
        );
      }
      const recipients = members.map((member) => ({
        user_id: member.user_id,
        public_key: member.public_key,
        fingerprint: member.fingerprint,
      }));
      const grants = await invoke<TauriEnvelope[]>("create_team_vault_key", {
        vaultId: id,
        teamId,
        recipients,
      });
      if (grants.length !== recipients.length)
        throw new Error("Some member key grants were not created.");
      let created: TeamVaultDto;
      try {
        created = await teamsApi.createVault(teamId, {
          id,
          name: vaultName,
          envelopes: grants.map(toServerEnvelope),
        });
      } catch (error) {
        // A lost response can follow a successful server commit. Recover by ID
        // using the original local key instead of creating a second vault.
        const existing = (await teamsApi.listVaults(teamId)).find(
          (vault) => vault.id === id,
        );
        if (!existing) throw error;
        created = existing;
      }
      await invoke("cache_team_vault_metadata", {
        vaultId: created.id,
        teamId,
        ownerId: created.owner_id,
        name: created.name,
        epoch: created.key_epoch,
        rotationState: created.rotation_state,
      });
      const shared = toSharedVault(created);
      const sharedVaults = [...get().sharedVaults, shared];
      set({ sharedVaults, selectedSharedVault: shared, isLoading: false });
      await saveCache(teamId, sharedVaults);
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  renameSharedVault: async (teamId, vaultId, name) => {
    set({ isLoading: true, error: null });
    try {
      const renamedDto = await teamsApi.renameVault(teamId, vaultId, name);
      const renamed = toSharedVault(renamedDto);
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
      await saveCache(teamId, sharedVaults);
      await invoke("cache_team_vault_metadata", {
        vaultId,
        teamId,
        ownerId: renamedDto.owner_id,
        name: renamed.name,
        epoch: renamedDto.key_epoch,
        rotationState: renamed.rotationState,
      });
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  deleteSharedVault: async (teamId, vaultId) => {
    set({ isLoading: true, error: null });
    try {
      await teamsApi.deleteVault(teamId, vaultId);
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
    await saveCache(teamId, sharedVaults);
    try {
      await invoke("revoke_cached_team_vault_command", { vaultId });
      window.dispatchEvent(
        new CustomEvent(TEAM_ACCESS_REVOKED_EVENT, { detail: { vaultId } }),
      );
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({
        error: `Shared vault deleted on the server, but its local access state could not be updated: ${errorText(error)}`,
      });
    }
  },
  rotateSharedVault: async (teamId, vaultId) => {
    set({ isLoading: true, error: null });
    try {
      const vault = (await teamsApi.listVaults(teamId)).find(
        (item) => item.id === vaultId,
      );
      if (vault?.rotation_state !== "rotation_required") {
        throw new Error("This shared vault no longer needs rotation.");
      }
      const members = await teamsApi.listMembers(teamId);
      if (
        members.length === 0 ||
        members.some((member) => !member.public_key || !member.fingerprint)
      ) {
        throw new Error(
          "Every remaining member needs a verified identity key.",
        );
      }
      const recipients = members.map((member) => ({
        user_id: member.user_id,
        public_key: member.public_key,
        fingerprint: member.fingerprint,
      }));
      const rows: RotationRowDto[] = [];
      let after = "";
      let hasMore = true;
      while (hasMore) {
        const page = await teamsApi.rotationSnapshot(vaultId, after);
        if (
          page.vault_id !== vaultId ||
          page.team_id !== teamId ||
          page.epoch !== vault.key_epoch ||
          page.revision !== vault.revision
        ) {
          throw new Error(
            "The shared vault changed during rotation. Refresh and retry.",
          );
        }
        rows.push(...(page.rows ?? []));
        hasMore = page.has_more;
        if (!hasMore) break;
        if (!page.next || page.next === after)
          throw new Error("Rotation snapshot did not advance.");
        after = page.next;
      }
      const prepared = await invoke<PreparedRotation>("prepare_team_rotation", {
        teamId,
        vaultId,
        expectedEpoch: vault.key_epoch,
        expectedRevision: vault.revision,
        rows,
        recipients,
      });
      const envelopes = prepared.envelopes.map(toServerEnvelope);
      for (
        let offset = 0;
        offset < prepared.rows.length || offset === 0;
        offset += 100
      ) {
        await teamsApi.stageRotation(vaultId, {
          operation_id: prepared.operation_id,
          expected_epoch: prepared.expected_epoch,
          expected_revision: prepared.expected_revision,
          rows: prepared.rows.slice(offset, offset + 100),
          envelopes,
        });
      }
      await teamsApi.commitRotation(vaultId, prepared.operation_id);
      await get().fetchSharedVaults(teamId);
      if (get().error)
        throw new Error(get().error ?? "Could not load the new team key.");
      set({ isLoading: false });
    } catch (error) {
      // A response can be lost after the atomic commit. Discover the committed
      // epoch and self envelope before reporting a failed rotation.
      try {
        const current = (await teamsApi.listVaults(teamId)).find(
          (vault) => vault.id === vaultId,
        );
        if (current?.rotation_state === "ready") {
          await get().fetchSharedVaults(teamId);
          if (!get().error) {
            set({ isLoading: false });
            return;
          }
        }
      } catch {
        /* Preserve the original failure. */
      }
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
