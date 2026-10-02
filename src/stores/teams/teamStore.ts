import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  type TeamDto,
  type TeamInviteDto,
  type TeamKeyEnvelopeDto,
  type TeamMemberDto,
  type TeamRole,
  teamsApi,
} from "@/lib/api/teams";
import { useAuthStore } from "@/stores/auth/authStore";
import { TEAM_ACCESS_REVOKED_EVENT } from "@/stores/sync/syncStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface TeamMember {
  id: string;
  userId: string;
  username: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
  publicKey: string;
  fingerprint: string;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  members?: TeamMember[];
  createdAt: string;
  updatedAt: string;
}

interface RecipientKey {
  user_id: string;
  public_key: string;
  fingerprint: string;
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

export function toServerEnvelope(envelope: TauriEnvelope): TeamKeyEnvelopeDto {
  return {
    vault_id: envelope.context.vault_id,
    team_id: envelope.context.team_id,
    epoch: envelope.context.epoch,
    recipient_user_id: envelope.context.recipient_user_id,
    recipient_fingerprint: envelope.context.recipient_fingerprint,
    version: envelope.version,
    ephemeral_public_key: envelope.ephemeral_public_key,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
  };
}

function toTauriEnvelope(envelope: TeamKeyEnvelopeDto): TauriEnvelope {
  return {
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
  };
}

const toTeam = (team: TeamDto): Team => ({
  id: team.id,
  name: team.name,
  ownerId: team.owner_id,
  createdAt: team.created_at,
  updatedAt: team.updated_at,
});
const toMember = (member: TeamMemberDto): TeamMember => ({
  id: member.id,
  userId: member.user_id,
  username: member.username,
  email: member.email,
  role: member.role,
  joinedAt: member.joined_at,
  publicKey: member.public_key,
  fingerprint: member.fingerprint,
});
const accountId = () => useAuthStore.getState().user?.id ?? "";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function saveCache(userId: string, teams: Team[]): Promise<void> {
  if (!userId) return;
  try {
    const store = await load("team-cache.json", { autoSave: false });
    await store.set(`teams:${userId}`, teams);
    await store.save();
  } catch {
    /* Insensitive metadata cache is best-effort. */
  }
}

async function readCache(userId: string): Promise<Team[]> {
  if (!userId) return [];
  try {
    const store = await load("team-cache.json", { autoSave: false });
    return (await store.get<Team[]>(`teams:${userId}`)) ?? [];
  } catch {
    return [];
  }
}

interface TeamState {
  teams: Team[];
  selectedTeam: Team | null;
  pendingInvites: TeamInviteDto[];
  accountId: string;
  isLoading: boolean;
  error: string | null;
  fetchTeams: () => Promise<void>;
  createTeam: (team: Partial<Team>) => Promise<void>;
  updateTeam: (id: string, team: Partial<Team>) => Promise<void>;
  deleteTeam: (id: string) => Promise<void>;
  selectTeam: (team: Team | null) => void;
  fetchTeamDetails: (teamId: string) => Promise<void>;
  addMember: (
    teamId: string,
    email: string,
    role: string,
    confirmedFingerprint?: string,
  ) => Promise<void>;
  removeMember: (teamId: string, userId: string) => Promise<void>;
  updateMemberRole: (
    teamId: string,
    userId: string,
    role: string,
  ) => Promise<void>;
  fetchMyInvites: () => Promise<void>;
  acceptInvite: (inviteId: string) => Promise<void>;
  declineInvite: (inviteId: string) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  selectedTeam: null,
  pendingInvites: [],
  accountId: "",
  isLoading: false,
  error: null,
  fetchTeams: async () => {
    const userId = accountId();
    if (get().accountId !== userId)
      set({
        teams: [],
        selectedTeam: null,
        pendingInvites: [],
        accountId: userId,
      });
    set({ isLoading: true, error: null });
    try {
      const teams = (await teamsApi.listTeams()).map(toTeam);
      const selectedId = get().selectedTeam?.id;
      set({
        teams,
        selectedTeam:
          teams.find((team) => team.id === selectedId) ?? teams[0] ?? null,
        isLoading: false,
      });
      await saveCache(userId, teams);
    } catch (error) {
      const cached = await readCache(userId);
      set({
        teams: cached,
        selectedTeam:
          cached.find((team) => team.id === get().selectedTeam?.id) ??
          cached[0] ??
          null,
        error: errorText(error),
        isLoading: false,
      });
    }
  },
  createTeam: async (team) => {
    set({ isLoading: true, error: null });
    try {
      const created = toTeam(await teamsApi.createTeam(team.name ?? ""));
      const teams = [...get().teams, created];
      set({ teams, selectedTeam: created, isLoading: false });
      await saveCache(accountId(), teams);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  updateTeam: async (id, team) => {
    set({ isLoading: true, error: null });
    try {
      const updated = toTeam(await teamsApi.updateTeam(id, team.name ?? ""));
      const teams = get().teams.map((item) =>
        item.id === id ? { ...item, ...updated } : item,
      );
      set({
        teams,
        selectedTeam:
          get().selectedTeam?.id === id
            ? (teams.find((item) => item.id === id) ?? null)
            : get().selectedTeam,
        isLoading: false,
      });
      await saveCache(accountId(), teams);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  deleteTeam: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await teamsApi.deleteTeam(id);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
    const teams = get().teams.filter((item) => item.id !== id);
    set({
      teams,
      selectedTeam:
        get().selectedTeam?.id === id ? (teams[0] ?? null) : get().selectedTeam,
      isLoading: false,
    });
    await saveCache(accountId(), teams);
    try {
      await invoke("revoke_cached_team_command", { teamId: id });
      window.dispatchEvent(new CustomEvent(TEAM_ACCESS_REVOKED_EVENT));
      await useVaultStore.getState().fetchVaults();
    } catch (error) {
      set({
        error: `Team deleted on the server, but its local access state could not be updated: ${errorText(error)}`,
      });
    }
  },
  selectTeam: (team) => set({ selectedTeam: team }),
  fetchTeamDetails: async (teamId) => {
    set({ isLoading: true, error: null });
    try {
      const members = (await teamsApi.listMembers(teamId)).map(toMember);
      const teams = get().teams.map((team) =>
        team.id === teamId ? { ...team, members } : team,
      );
      set({
        teams,
        selectedTeam: teams.find((team) => team.id === teamId) ?? null,
        isLoading: false,
      });
      await saveCache(accountId(), teams);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  addMember: async (teamId, email, role, confirmedFingerprint) => {
    set({ isLoading: true, error: null });
    try {
      if (role !== "member" && role !== "admin")
        throw new Error("Invalid team role.");
      const recipient = await teamsApi.recipientKey(
        teamId,
        email.trim().toLowerCase(),
      );
      if (
        !confirmedFingerprint ||
        confirmedFingerprint !== recipient.fingerprint
      )
        throw new Error(
          "Compare the recipient key fingerprint with them before inviting.",
        );
      const vaults = await teamsApi.listVaults(teamId);
      const recipientKey: RecipientKey = {
        user_id: recipient.user_id,
        public_key: recipient.public_key,
        fingerprint: recipient.fingerprint,
      };
      const envelopes: TeamKeyEnvelopeDto[] = [];
      for (const vault of vaults) {
        const envelope = await invoke<TauriEnvelope>("grant_team_vault_key", {
          vaultId: vault.id,
          recipient: recipientKey,
        });
        envelopes.push(toServerEnvelope(envelope));
      }
      await teamsApi.invite(teamId, {
        email,
        role,
        recipient_fingerprint: recipient.fingerprint,
        envelopes,
      });
      set({ isLoading: false });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  removeMember: async (teamId, userId) => {
    set({ isLoading: true, error: null });
    try {
      await teamsApi.removeMember(teamId, userId);
      await get().fetchTeamDetails(teamId);
      const { useSharedVaultStore } = await import("./sharedVaultStore");
      await useSharedVaultStore.getState().fetchSharedVaults(teamId);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  updateMemberRole: async (teamId, userId, role) => {
    set({ isLoading: true, error: null });
    try {
      if (role !== "admin" && role !== "member")
        throw new Error("Invalid team role.");
      await teamsApi.updateMemberRole(teamId, userId, role);
      await get().fetchTeamDetails(teamId);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  fetchMyInvites: async () => {
    try {
      set({ pendingInvites: await teamsApi.myInvites(), error: null });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  acceptInvite: async (inviteId) => {
    set({ isLoading: true, error: null });
    try {
      const userId = accountId();
      if (!userId) throw new Error("Sign in before accepting an invitation.");
      const invite = await teamsApi.acceptInvite(inviteId);
      const vaults = await teamsApi.listVaults(invite.team_id);
      for (const vault of vaults) {
        const envelope = await teamsApi.keyEnvelope(vault.id);
        await invoke("import_team_key_envelope", {
          envelope: toTauriEnvelope(envelope),
          userId,
        });
        await invoke("cache_team_vault_metadata", {
          vaultId: vault.id,
          teamId: invite.team_id,
          ownerId: vault.owner_id,
          name: vault.name,
          epoch: vault.key_epoch,
          rotationState: vault.rotation_state,
        });
      }
      await get().fetchTeams();
      await useVaultStore.getState().fetchVaults();
      set({
        pendingInvites: get().pendingInvites.filter(
          (item) => item.id !== inviteId,
        ),
        isLoading: false,
      });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  declineInvite: async (inviteId) => {
    set({ isLoading: true, error: null });
    try {
      await teamsApi.declineInvite(inviteId);
      set({
        pendingInvites: get().pendingInvites.filter(
          (item) => item.id !== inviteId,
        ),
        isLoading: false,
      });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  clearError: () => set({ error: null }),
  reset: () =>
    set({
      teams: [],
      selectedTeam: null,
      pendingInvites: [],
      accountId: "",
      error: null,
      isLoading: false,
    }),
}));
