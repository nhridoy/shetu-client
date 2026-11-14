import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDeviceId } from "@/lib/common/device";
import { decryptRowData } from "@/lib/crypto/crypto";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username?: string;
  groupId?: string | null;
  tags: string[];
  color?: string;
  icon?: string;
  os?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  vaultId?: string;
  authType?: "password" | "key" | "both" | "none";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  keyId?: string;
  jumpHostId?: string | null;
  keepaliveSecs?: number | null;
  forwardAgent?: boolean;
  env?: { name: string; value: string }[];
  startup?: { snippetId: string } | { command: string } | null;
  /** @internal encrypted payload blob — kept for on-demand decrypt, never render */
  data?: string;
}

export interface Group {
  id: string;
  name: string;
  parentId?: string | null;
  vaultId?: string;
  sortOrder: number;
  createdAt: string;
}

interface HostState {
  hosts: Host[];
  groups: Group[];
  selectedHost: Host | null;
  isLoading: boolean;
  error: string | null;

  fetchHosts: (vaultId?: string) => Promise<void>;
  fetchGroups: (vaultId?: string) => Promise<void>;
  createHost: (
    host: Partial<Host>,
    opts?: { probeOs?: boolean },
  ) => Promise<Host | null>;
  /** False when the save failed (the reason is in `error`). */
  updateHost: (id: string, host: Partial<Host>) => Promise<boolean>;
  deleteHost: (id: string) => Promise<void>;
  selectHost: (host: Host | null) => void;
  getDecryptedHost: (hostId: string) => Promise<Host | null>;
  updateHostOs: (hostId: string, os: string) => Promise<void>;
  updateHostGroup: (hostId: string, groupId: string) => Promise<void>;
  reorderHosts: (orderedIds: string[]) => Promise<void>;
  getCredentialsForHost: (
    hostId: string,
  ) => Promise<{ password: string; privateKey: string; passphrase: string }>;
  createGroup: (group: Partial<Group>) => Promise<void>;
  updateGroup: (id: string, group: Partial<Group>) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  clearError: () => void;
}

interface HostPayload {
  address: string;
  port: number;
  username: string;
  password?: string;
  jumpHostId?: string | null;
  keepaliveSecs?: number | null;
  forwardAgent?: boolean;
  env?: { name: string; value: string }[];
  startup?: { snippetId: string } | { command: string } | null;
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** List-safe mapping: reads plaintext columns only, no decryption. Sensitive
 * fields (address/port/username/password) are empty until getDecryptedHost. */
function hostFromRow(row: SyncRow): Host {
  return {
    id: row.id,
    name: row.name ?? "",
    address: "",
    port: 22,
    username: undefined,
    groupId: row.group_id ?? null,
    tags: parseTags(row.tags),
    color: row.color ?? "#64748b",
    os: row.os ?? undefined,
    sortOrder: row.sort_order,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    vaultId: row.vault_id,
    authType:
      (row.auth_type as "password" | "key" | "both" | "none") ?? "password",
    password: undefined,
    keyId: row.key_id ?? undefined,
    data: row.data ?? "",
  };
}

/** Map a decrypted payload onto Host fields, tolerating junk stored values. */
function hostFieldsFromPayload(
  payload: Partial<HostPayload>,
): Pick<
  Host,
  | "address"
  | "port"
  | "username"
  | "password"
  | "jumpHostId"
  | "keepaliveSecs"
  | "forwardAgent"
  | "env"
  | "startup"
> {
  const p = payload as Record<string, unknown>;
  const startup = p.startup as Record<string, unknown> | null | undefined;
  return {
    address: payload.address ?? "",
    port: payload.port ?? 22,
    username: payload.username ?? "root",
    password: payload.password,
    jumpHostId: payload.jumpHostId ?? null,
    keepaliveSecs:
      typeof p.keepaliveSecs === "number" && Number.isFinite(p.keepaliveSecs)
        ? p.keepaliveSecs
        : null,
    forwardAgent: p.forwardAgent === true,
    env: Array.isArray(p.env)
      ? p.env.filter(
          (e): e is { name: string; value: string } =>
            typeof e?.name === "string" && typeof e?.value === "string",
        )
      : [],
    startup:
      startup && typeof startup === "object"
        ? typeof startup.snippetId === "string" && startup.snippetId
          ? { snippetId: startup.snippetId }
          : typeof startup.command === "string"
            ? { command: startup.command }
            : null
        : null,
  };
}

/** Full host with decrypted credentials — decrypt on demand. */
async function decryptHostRow(row: SyncRow): Promise<Host> {
  const payload = ((await decryptRowData(row.data)) ??
    {}) as Partial<HostPayload>;
  return { ...hostFromRow(row), ...hostFieldsFromPayload(payload) };
}

function newId(): string {
  return crypto.randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeHostOs(hostId: string): Promise<void> {
  try {
    const { useHostPingStore } = await import("@/stores/hosts/hostPingStore");
    useHostPingStore.setState((s) => ({
      pings: { ...s.pings, [hostId]: { status: "pinging" } },
    }));
    const hostStore = useHostStore.getState();
    const result = await invoke<{
      reachable: boolean;
      latency_ms: number | null;
      os: string | null;
    }>("ping_host_saved", { hostId, detectOs: true });
    if (result.os) {
      await hostStore.updateHostOs(hostId, result.os);
    }
    useHostPingStore.setState((s) => ({
      pings: {
        ...s.pings,
        [hostId]: {
          status: result.reachable ? "reachable" : "unreachable",
          latencyMs: result.latency_ms ?? undefined,
          os: result.os ?? undefined,
        },
      },
    }));
  } catch {
    // Silent — connect-time detection covers failures
  }
}

export const useHostStore = create<HostState>((set, get) => ({
  hosts: [],
  groups: [],
  selectedHost: null,
  isLoading: false,
  error: null,

  fetchHosts: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("hosts", vid);
      const hosts = rows.map((row) => hostFromRow(row));
      set({ hosts, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  fetchGroups: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("groups", vid);
      const groups = rows.map((row) => ({
        id: row.id,
        name: row.name ?? "",
        parentId: row.parent_id ?? null,
        vaultId: row.vault_id,
        sortOrder: row.sort_order,
        createdAt: String(row.created_at),
      }));
      set({ groups, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  createHost: async (host, opts) => {
    const vaultId = host.vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return null;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "hosts",
        {
          id: host.id ?? newId(),
          vault_id: vaultId,
          name: host.name ?? "",
          os: host.os ?? null,
          auth_type: host.authType ?? "password",
          tags: JSON.stringify(host.tags ?? []),
          color: host.color ?? null,
          group_id: host.groupId ?? null,
          key_id: host.keyId ?? null,
          sort_order:
            host.sortOrder ??
            (() => {
              const groupHosts = get().hosts.filter(
                (h) => (h.groupId ?? null) === (host.groupId ?? null),
              );
              return groupHosts.length > 0
                ? Math.max(...groupHosts.map((h) => h.sortOrder)) + 1
                : 0;
            })(),
        },
        {
          plaintext: JSON.stringify({
            address: host.address,
            port: host.port ?? 22,
            username: host.username ?? "root",
            password: host.password,
            jumpHostId: host.jumpHostId ?? null,
            keepaliveSecs: host.keepaliveSecs ?? null,
            forwardAgent: host.forwardAgent ?? false,
            env: host.env ?? [],
            startup: host.startup ?? null,
          }),
          recordType: "hosts",
        },
      );
      const created: Host = {
        id: row.id,
        name: row.name ?? "",
        address: "",
        port: 22,
        username: undefined,
        groupId: host.groupId ?? null,
        tags: host.tags ?? [],
        color: host.color ?? "#64748b",
        os: host.os,
        sortOrder: host.sortOrder ?? 0,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        vaultId,
        authType: host.authType ?? "password",
        password: undefined,
        keyId: host.keyId ?? undefined,
        jumpHostId: host.jumpHostId ?? null,
        data: row.data,
      };
      set({ hosts: [created, ...get().hosts], isLoading: false });
      if (opts?.probeOs !== false) void probeHostOs(created.id);
      return created;
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
      return null;
    }
  },

  updateHost: async (id, patch) => {
    set({ isLoading: true, error: null });
    try {
      const row = await getRow("hosts", id);
      if (!row) {
        set({ isLoading: false, error: "Host not found" });
        return false;
      }
      const existing = ((await decryptRowData(row.data)) ?? {}) as Record<
        string,
        unknown
      >;
      const sensitive: Record<string, unknown> = {};
      if (patch.address !== undefined) sensitive.address = patch.address;
      if (patch.port !== undefined) sensitive.port = patch.port;
      if (patch.username !== undefined) sensitive.username = patch.username;
      if (patch.password !== undefined) sensitive.password = patch.password;
      if (patch.jumpHostId !== undefined)
        sensitive.jumpHostId = patch.jumpHostId;
      if (patch.keepaliveSecs !== undefined)
        sensitive.keepaliveSecs = patch.keepaliveSecs;
      if (patch.forwardAgent !== undefined)
        sensitive.forwardAgent = patch.forwardAgent;
      if (patch.env !== undefined) sensitive.env = patch.env;
      if (patch.startup !== undefined) sensitive.startup = patch.startup;
      const saved = await upsertRow(
        "hosts",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: patch.name ?? row.name,
          os: patch.os !== undefined ? patch.os : (row.os ?? null),
          auth_type:
            patch.authType !== undefined
              ? patch.authType
              : (row.auth_type ?? "password"),
          tags:
            patch.tags !== undefined
              ? JSON.stringify(patch.tags)
              : (row.tags ?? "[]"),
          color: patch.color !== undefined ? patch.color : (row.color ?? null),
          group_id:
            patch.groupId !== undefined
              ? patch.groupId
              : (row.group_id ?? null),
          key_id:
            patch.keyId !== undefined ? patch.keyId : (row.key_id ?? null),
          sort_order: patch.sortOrder ?? row.sort_order,
        },
        {
          plaintext: JSON.stringify({ ...existing, ...sensitive }),
          recordType: "hosts",
        },
      );
      set({
        hosts: get().hosts.map((h) =>
          h.id === id ? { ...h, ...patch, data: saved.data } : h,
        ),
        isLoading: false,
      });
      void probeHostOs(id);
      return true;
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
      return false;
    }
  },

  deleteHost: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("hosts", id);
      set((s) => ({
        hosts: s.hosts.filter((h) => h.id !== id),
        selectedHost: s.selectedHost?.id === id ? null : s.selectedHost,
        isLoading: false,
      }));
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  reorderHosts: async (orderedIds) => {
    const updates = orderedIds.map((id, i) => ({ id, sort_order: i }));
    try {
      await invoke("db_update_sort_orders", {
        table: "hosts",
        updates,
        deviceId: await getDeviceId(),
      });
      const vaultId = get().hosts.find((host) =>
        orderedIds.includes(host.id),
      )?.vaultId;
      if (vaultId && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("shetu:local-mutation", {
            detail: { table: "hosts", vaultId },
          }),
        );
      }
    } catch (err) {
      console.error("[reorderHosts] IPC failed:", err);
    }
    set((s) => ({
      hosts: s.hosts.map((h) => ({
        ...h,
        sortOrder: orderedIds.indexOf(h.id),
      })),
    }));
  },

  selectHost: (host) => set({ selectedHost: host }),

  getDecryptedHost: async (hostId) => {
    const cached = get().hosts.find((h) => h.id === hostId);
    if (cached?.data) {
      const payload = ((await decryptRowData(cached.data)) ??
        {}) as Partial<HostPayload>;
      return { ...cached, ...hostFieldsFromPayload(payload) };
    }
    const row = await getRow("hosts", hostId);
    if (!row) {
      return null;
    }
    return decryptHostRow(row);
  },

  updateHostOs: async (hostId, os) => {
    set({
      hosts: get().hosts.map((h) => (h.id === hostId ? { ...h, os } : h)),
    });
  },

  updateHostGroup: async (hostId, groupId) => {
    try {
      await invoke("db_update_host_group", {
        hostId,
        groupId,
        deviceId: await getDeviceId(),
      });
      const vaultId = get().hosts.find((host) => host.id === hostId)?.vaultId;
      if (vaultId && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("shetu:local-mutation", {
            detail: { table: "hosts", vaultId },
          }),
        );
      }
    } catch (err) {
      console.error("[updateHostGroup] IPC failed:", err);
    }
    set((s) => ({
      hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, groupId } : h)),
    }));
  },

  getCredentialsForHost: async (hostId) => {
    const cached = get().hosts.find((h) => h.id === hostId);
    let data = cached?.data;
    let authType = cached?.authType ?? "password";
    let keyId = cached?.keyId;
    if (data == null) {
      const row = await getRow("hosts", hostId);
      if (!row) {
        return { password: "", privateKey: "", passphrase: "" };
      }
      data = row.data;
      authType =
        (row.auth_type as "password" | "key" | "both" | "none") ?? "password";
      keyId = row.key_id ?? undefined;
    }
    const payload = ((await decryptRowData(data)) ??
      {}) as Partial<HostPayload>;
    if (authType === "key" && keyId) {
      const keyCreds = await useKeyStore.getState().getCredentialsForKey(keyId);
      return { password: "", privateKey: keyCreds, passphrase: "" };
    }
    if (authType === "both" && keyId) {
      const keyCreds = await useKeyStore.getState().getCredentialsForKey(keyId);
      return {
        password: payload.password ?? "",
        privateKey: keyCreds,
        passphrase: "",
      };
    }
    return { password: payload.password ?? "", privateKey: "", passphrase: "" };
  },

  createGroup: async (group) => {
    const vaultId = group.vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "groups",
        {
          id: newId(),
          vault_id: vaultId,
          name: group.name ?? "",
          parent_id: group.parentId ?? null,
          sort_order: group.sortOrder ?? 0,
        },
        { plaintext: "{}", recordType: "groups" },
      );
      const created: Group = {
        id: row.id,
        name: row.name ?? "",
        parentId: group.parentId ?? null,
        vaultId,
        sortOrder: group.sortOrder ?? 0,
        createdAt: String(row.created_at),
      };
      set({ groups: [created, ...get().groups], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  updateGroup: async (id, patch) => {
    set({ isLoading: true, error: null });
    try {
      const row = await getRow("groups", id);
      if (!row) {
        set({ isLoading: false, error: "Group not found" });
        return;
      }
      await decryptRowData(row.data);
      await upsertRow(
        "groups",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: patch.name ?? row.name,
          parent_id:
            patch.parentId !== undefined
              ? patch.parentId
              : (row.parent_id ?? null),
          sort_order: patch.sortOrder ?? row.sort_order,
        },
        { plaintext: "{}", recordType: "groups" },
      );
      set({
        groups: get().groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  deleteGroup: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("groups", id);
      set((s) => ({
        groups: s.groups.filter((g) => g.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
