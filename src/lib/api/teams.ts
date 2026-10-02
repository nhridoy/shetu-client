import { httpRequest } from "./http";

export type TeamRole = "owner" | "admin" | "member";

export interface TeamDto {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberDto {
  id: string;
  user_id: string;
  email: string;
  username: string;
  role: TeamRole;
  joined_at: string;
  public_key: string;
  fingerprint: string;
}

export interface TeamInviteDto {
  id: string;
  team_id: string;
  recipient_user_id: string;
  recipient_email: string;
  recipient_fingerprint: string;
  role: TeamRole;
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  expires_at: string;
  created_at: string;
}

export interface TeamVaultDto {
  id: string;
  owner_id: string;
  team_id: string;
  name: string;
  kind: "team";
  key_epoch: number;
  revision: number;
  rotation_state: string;
  created_at: string;
  updated_at: string;
}

export interface TeamKeyEnvelopeDto {
  vault_id: string;
  team_id: string;
  epoch: number;
  recipient_user_id: string;
  recipient_fingerprint: string;
  version: number;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
}

export interface RotationRowDto {
  table: string;
  id: string;
  revision: number;
  data: string;
}

export interface RotationSnapshotDto {
  vault_id: string;
  team_id: string;
  epoch: number;
  revision: number;
  rows: RotationRowDto[] | null;
  next: string;
  has_more: boolean;
}

export interface RotationStageDto {
  operation_id: string;
  expected_epoch: number;
  expected_revision: number;
  rows: RotationRowDto[];
  envelopes: TeamKeyEnvelopeDto[];
}

export interface RecipientKeyDto {
  user_id: string;
  public_key: string;
  fingerprint: string;
}

export class TeamApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await httpRequest(method, path, body);
  let payload: {
    data?: T;
    error?: { code?: string; message?: string };
  } | null = null;
  try {
    payload = response.body ? JSON.parse(response.body) : null;
  } catch {
    throw new TeamApiError(
      response.status,
      "INVALID_RESPONSE",
      "The server returned an invalid response.",
    );
  }
  if (response.status >= 400) {
    throw new TeamApiError(
      response.status,
      payload?.error?.code ?? "TEAM_REQUEST_FAILED",
      payload?.error?.message ?? `Team request failed (${response.status}).`,
    );
  }
  if (response.status === 204) return undefined as T;
  if (payload?.data === undefined)
    throw new TeamApiError(
      response.status,
      "INVALID_RESPONSE",
      "The server response was incomplete.",
    );
  return payload.data;
}

const teamPath = (teamId: string) =>
  `/api/v1/teams/${encodeURIComponent(teamId)}`;

export const teamsApi = {
  listTeams: () => request<TeamDto[]>("GET", "/api/v1/teams"),
  createTeam: (name: string) =>
    request<TeamDto>("POST", "/api/v1/teams", { name }),
  listMembers: (teamId: string) =>
    request<TeamMemberDto[]>("GET", `${teamPath(teamId)}/members`),
  recipientKey: (teamId: string, email: string) =>
    request<RecipientKeyDto>(
      "GET",
      `${teamPath(teamId)}/recipient-key?email=${encodeURIComponent(email)}`,
    ),
  invite: (
    teamId: string,
    body: {
      email: string;
      role: "admin" | "member";
      recipient_fingerprint: string;
      envelopes: TeamKeyEnvelopeDto[];
    },
  ) => request<TeamInviteDto>("POST", `${teamPath(teamId)}/invites`, body),
  myInvites: () =>
    request<TeamInviteDto[]>("GET", "/api/v1/teams/invites/mine"),
  acceptInvite: (inviteId: string) =>
    request<TeamInviteDto>(
      "POST",
      `/api/v1/teams/invites/${encodeURIComponent(inviteId)}/accept`,
    ),
  declineInvite: (inviteId: string) =>
    request<TeamInviteDto>(
      "POST",
      `/api/v1/teams/invites/${encodeURIComponent(inviteId)}/decline`,
    ),
  listVaults: (teamId: string) =>
    request<TeamVaultDto[]>("GET", `${teamPath(teamId)}/vaults`),
  createVault: (
    teamId: string,
    body: { id: string; name: string; envelopes: TeamKeyEnvelopeDto[] },
  ) => request<TeamVaultDto>("POST", `${teamPath(teamId)}/vaults`, body),
  renameVault: (teamId: string, vaultId: string, name: string) =>
    request<TeamVaultDto>(
      "PATCH",
      `${teamPath(teamId)}/vaults/${encodeURIComponent(vaultId)}`,
      { name },
    ),
  keyEnvelope: (vaultId: string) =>
    request<TeamKeyEnvelopeDto>(
      "GET",
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/key-envelope`,
    ),
  rotationSnapshot: (vaultId: string, after = "") =>
    request<RotationSnapshotDto>(
      "GET",
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/rotation/snapshot?after=${encodeURIComponent(after)}`,
    ),
  stageRotation: (vaultId: string, body: RotationStageDto) =>
    request<{ operation_id: string; state: string }>(
      "POST",
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/rotation/stage`,
      body,
    ),
  commitRotation: (vaultId: string, operationId: string) =>
    request<{ operation_id: string; state: string }>(
      "POST",
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/rotation/commit`,
      { operation_id: operationId },
    ),
  deleteVault: (teamId: string, vaultId: string) =>
    request<void>(
      "DELETE",
      `${teamPath(teamId)}/vaults/${encodeURIComponent(vaultId)}`,
    ),
  removeMember: (teamId: string, userId: string) =>
    request<void>(
      "DELETE",
      `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
    ),
  updateMemberRole: (
    teamId: string,
    userId: string,
    role: "admin" | "member",
  ) =>
    request<TeamMemberDto>(
      "PATCH",
      `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
      { role },
    ),
  deleteTeam: (teamId: string) => request<void>("DELETE", teamPath(teamId)),
  updateTeam: (teamId: string, name: string) =>
    request<TeamDto>("PATCH", teamPath(teamId), { name }),
};
