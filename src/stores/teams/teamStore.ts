import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists } from "@tauri-apps/plugin-fs";
import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type {
  TeamInviteDto,
  TeamKeyEnvelopeDto,
  TeamRole,
} from "@/lib/api/teams";
import { useAuthStore } from "@/stores/auth/authStore";
import { notifyTeamMutation } from "@/stores/sync/syncStore";

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
  syncStatus: "pending" | "synced" | "rejected";
  syncError?: string | null;
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

const accountId = () => useAuthStore.getState().user?.id ?? "";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function importLegacyTeamCacheOnce(userId: string): Promise<void> {
  if (await invoke<boolean>("team_cache_imported", { accountId: userId }))
    return;
  let teams: Array<Record<string, unknown>> = [];
  const vaults: Array<Record<string, unknown>> = [];
  try {
    if (
      !(await exists("team-cache.json", { baseDir: BaseDirectory.AppData }))
    ) {
      await invoke("import_legacy_team_cache", {
        accountId: userId,
        teams,
        vaults,
      });
      return;
    }
    const store = await load("team-cache.json", { autoSave: false });
    teams =
      (await store.get<Array<Record<string, unknown>>>(`teams:${userId}`)) ??
      [];
    for (const team of teams) {
      const teamId = typeof team.id === "string" ? team.id : "";
      if (!teamId) continue;
      const cachedVaults =
        (await store.get<Array<Record<string, unknown>>>(
          `vaults:${userId}:${teamId}`,
        )) ?? [];
      vaults.push(...cachedVaults.map((vault) => ({ ...vault, teamId })));
    }
  } catch {
    // A missing legacy cache is a normal first-run case.
  }
  await invoke("import_legacy_team_cache", {
    accountId: userId,
    teams,
    vaults,
  });
}

async function queueOperation(type: string, payload: Record<string, unknown>) {
  const userId = accountId();
  if (!userId) throw new Error("Sign in to make team changes.");
  await invoke("queue_team_operation", {
    accountId: userId,
    operationType: type,
    payload: JSON.stringify(payload),
  });
  notifyTeamMutation();
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
      if (userId) await importLegacyTeamCacheOnce(userId);
      const rows = await invoke<
        Array<{
          id: string;
          name: string;
          ownerId: string;
          createdAt: string;
          updatedAt: string;
          syncStatus: "pending" | "synced" | "rejected";
          syncError: string | null;
        }>
      >("local_teams", { accountId: userId });
      const membersByTeam = new Map(
        get().teams.map((team) => [team.id, team.members]),
      );
      const teams = rows.map((row) => ({
        id: row.id,
        name: row.name,
        ownerId: row.ownerId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        syncStatus: row.syncStatus,
        syncError: row.syncError,
        members: membersByTeam.get(row.id),
      }));
      const selectedId = get().selectedTeam?.id;
      set({
        teams,
        selectedTeam:
          teams.find((team) => team.id === selectedId) ?? teams[0] ?? null,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: errorText(error),
        isLoading: false,
      });
    }
  },
  createTeam: async (team) => {
    set({ isLoading: true, error: null });
    try {
      const teamId = crypto.randomUUID();
      await queueOperation("team.create", {
        team_id: teamId,
        name: team.name?.trim() ?? "",
      });
      await get().fetchTeams();
      const created = get().teams.find((item) => item.id === teamId) ?? null;
      set({ selectedTeam: created, isLoading: false });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  updateTeam: async (id, team) => {
    set({ isLoading: true, error: null });
    try {
      await queueOperation("team.rename", {
        team_id: id,
        name: team.name?.trim() ?? "",
      });
      await get().fetchTeams();
      const teams = get().teams;
      set({
        teams,
        selectedTeam:
          get().selectedTeam?.id === id
            ? (teams.find((item) => item.id === id) ?? null)
            : get().selectedTeam,
        isLoading: false,
      });
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  deleteTeam: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await queueOperation("team.delete", { team_id: id });
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
  },
  selectTeam: (team) => set({ selectedTeam: team }),
  fetchTeamDetails: async (teamId) => {
    set({ isLoading: true, error: null });
    try {
      const rows = await invoke<
        Array<{
          id: string;
          userId: string;
          email: string;
          fullName: string;
          role: TeamRole;
          createdAt: string;
          publicKey: string;
          fingerprint: string;
        }>
      >("local_team_members", { accountId: accountId(), teamId });
      const members = rows.map((member) => ({
        id: member.id,
        userId: member.userId,
        username: member.fullName,
        email: member.email,
        role: member.role,
        joinedAt: member.createdAt,
        publicKey: member.publicKey,
        fingerprint: member.fingerprint,
      }));
      const teams = get().teams.map((team) =>
        team.id === teamId ? { ...team, members } : team,
      );
      set({
        teams,
        selectedTeam: teams.find((team) => team.id === teamId) ?? null,
        isLoading: false,
      });
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
      const recipient = await invoke<RecipientKey>(
        "lookup_team_recipient_key",
        {
          teamId,
          email: email.trim().toLowerCase(),
        },
      );
      if (
        !confirmedFingerprint ||
        confirmedFingerprint !== recipient.fingerprint
      )
        throw new Error(
          "Compare the recipient key fingerprint with them before inviting.",
        );
      const vaults = await invoke<Array<{ id: string }>>("local_team_vaults", {
        accountId: accountId(),
        teamId,
      });
      const envelopes: TeamKeyEnvelopeDto[] = [];
      for (const vault of vaults) {
        const envelope = await invoke<TauriEnvelope>("grant_team_vault_key", {
          vaultId: vault.id,
          recipient,
        });
        envelopes.push(toServerEnvelope(envelope));
      }
      await queueOperation("invite.create", {
        invite_id: crypto.randomUUID(),
        team_id: teamId,
        email: email.trim().toLowerCase(),
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
      await queueOperation("member.remove", {
        team_id: teamId,
        user_id: userId,
      });
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
      await queueOperation("member.role", {
        team_id: teamId,
        user_id: userId,
        role,
      });
      await get().fetchTeamDetails(teamId);
    } catch (error) {
      set({ error: errorText(error), isLoading: false });
      throw error;
    }
  },
  fetchMyInvites: async () => {
    try {
      const rows = await invoke<
        Array<{
          id: string;
          teamId: string;
          email: string;
          role: TeamRole;
          status: string;
          createdAt: string;
          expiresAt: string;
        }>
      >("local_team_invites", { accountId: accountId() });
      set({
        pendingInvites: rows.map(
          (invite) =>
            ({
              id: invite.id,
              team_id: invite.teamId,
              recipient_email: invite.email,
              role: invite.role,
              state: invite.status,
              created_at: invite.createdAt,
              expires_at: invite.expiresAt || invite.createdAt,
            }) as TeamInviteDto,
        ),
        error: null,
      });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  acceptInvite: async (inviteId) => {
    set({ isLoading: true, error: null });
    try {
      const userId = accountId();
      if (!userId) throw new Error("Sign in before accepting an invitation.");
      await queueOperation("invite.accept", { invite_id: inviteId });
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
      await queueOperation("invite.decline", { invite_id: inviteId });
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
