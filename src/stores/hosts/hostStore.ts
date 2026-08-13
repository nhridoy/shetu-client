import { create } from "zustand";
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
  authType?: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  keyId?: string;
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
  createHost: (host: Partial<Host>) => Promise<void>;
  updateHost: (id: string, host: Partial<Host>) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  selectHost: (host: Host | null) => void;
  getDecryptedHost: (hostId: string) => Promise<Host | null>;
  updateHostOs: (hostId: string, os: string) => Promise<void>;
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
    authType: (row.auth_type as "password" | "key") ?? "password",
    password: undefined,
    keyId: row.key_id ?? undefined,
    data: row.data ?? "",
  };
}

/** Full host with decrypted credentials — decrypt on demand. */
async function decryptHostRow(row: SyncRow): Promise<Host> {
  const payload = ((await decryptRowData(row.data)) ??
    {}) as Partial<HostPayload>;
  return {
    ...hostFromRow(row),
    address: payload.address ?? "",
    port: payload.port ?? 22,
    username: payload.username ?? "root",
    password: payload.password,
  };
}

function newId(): string {
  return crypto.randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeHostOs(hostId: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hostStore = useHostStore.getState();
    const host = await hostStore.getDecryptedHost(hostId);
    if (!host?.address) return;
    const creds = await hostStore.getCredentialsForHost(hostId);
    const result = await invoke<{
      reachable: boolean;
      latency_ms: number | null;
      os: string | null;
    }>("ping_host", {
      config: {
        host: host.address,
        port: host.port,
        username: host.username ?? "root",
        password: creds.password,
        privateKey: creds.privateKey,
        passphrase: creds.passphrase,
      },
    });
    if (result.os) {
      await hostStore.updateHostOs(hostId, result.os);
    }
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

  createHost: async (host) => {
    const vaultId = host.vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "hosts",
        {
          id: newId(),
          vault_id: vaultId,
          name: host.name ?? "",
          os: host.os ?? null,
          auth_type: host.authType ?? "password",
          tags: JSON.stringify(host.tags ?? []),
          color: host.color ?? null,
          group_id: host.groupId ?? null,
          key_id: host.keyId ?? null,
          sort_order: host.sortOrder ?? 0,
        },
        {
          plaintext: JSON.stringify({
            address: host.address,
            port: host.port ?? 22,
            username: host.username ?? "root",
            password: host.password,
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
        data: row.data,
      };
      set({ hosts: [created, ...get().hosts], isLoading: false });
      void probeHostOs(created.id);
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  updateHost: async (id, patch) => {
    set({ isLoading: true, error: null });
    try {
      const row = await getRow("hosts", id);
      if (!row) {
        set({ isLoading: false, error: "Host not found" });
        return;
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
      const saved = await upsertRow(
        "hosts",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: patch.name ?? row.name,
          os: patch.os !== undefined ? patch.os : (row.os ?? null),
          auth_type:
            patch.authType !== undefined ? patch.authType : (row.auth_type ?? "password"),
          tags:
            patch.tags !== undefined
              ? JSON.stringify(patch.tags)
              : (row.tags ?? "[]"),
          color:
            patch.color !== undefined ? patch.color : (row.color ?? null),
          group_id:
            patch.groupId !== undefined ? patch.groupId : (row.group_id ?? null),
          key_id: patch.keyId !== undefined ? patch.keyId : (row.key_id ?? null),
          sort_order: patch.sortOrder ?? row.sort_order,
        },
        {
          plaintext: JSON.stringify({ ...existing, ...sensitive }),
          recordType: "hosts",
        },
      );
      set({
        hosts: get().hosts.map((h) => (h.id === id ? { ...h, ...patch, data: saved.data } : h)),
        isLoading: false,
      });
      void probeHostOs(id);
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
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

  selectHost: (host) => set({ selectedHost: host }),

  getDecryptedHost: async (hostId) => {
    const cached = get().hosts.find((h) => h.id === hostId);
    if (cached?.data) {
      const payload = ((await decryptRowData(cached.data)) ??
        {}) as Partial<HostPayload>;
      return {
        ...cached,
        address: payload.address ?? "",
        port: payload.port ?? 22,
        username: payload.username ?? "root",
        password: payload.password,
      };
    }
    const row = await getRow("hosts", hostId);
    if (!row) {
      return null;
    }
    return decryptHostRow(row);
  },

  updateHostOs: async (hostId, os) => {
    try {
      const cached = get().hosts.find((h) => h.id === hostId);
      let vaultId = cached?.vaultId;
      if (vaultId == null) {
        const row = await getRow("hosts", hostId);
        if (!row) {
          return;
        }
        vaultId = row.vault_id;
      }
      await upsertRow(
        "hosts",
        {
          id: hostId,
          vault_id: vaultId,
          os,
        },
        {},
      );
      set({
        hosts: get().hosts.map((h) => (h.id === hostId ? { ...h, os } : h)),
      });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
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
      authType = (row.auth_type as "password" | "key") ?? "password";
      keyId = row.key_id ?? undefined;
    }
    const payload = ((await decryptRowData(data)) ??
      {}) as Partial<HostPayload>;
    if (authType === "key" && keyId) {
      const keyCreds = await useKeyStore
        .getState()
        .getCredentialsForKey(keyId);
      return { password: "", privateKey: keyCreds, passphrase: "" };
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
