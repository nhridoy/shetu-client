import { create } from "zustand";
import { decryptRowData } from "@/lib/crypto/crypto";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Workspace {
  id: string;
  name: string;
  layout: string;
  vaultId?: string;
  hostIds?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  isLoading: boolean;
  error: string | null;

  fetchWorkspaces: (vaultId?: string) => Promise<void>;
  createWorkspace: (
    name: string,
    layout: Record<string, unknown>,
    vaultId?: string,
  ) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  clearError: () => void;
}

function newId(): string {
  return crypto.randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function workspaceFromRow(row: SyncRow): Promise<Workspace> {
  const payload = (await decryptRowData(row.data)) as {
    layout?: string;
    hostIds?: string;
  } | null;
  return {
    id: row.id,
    name: row.name ?? "",
    layout: (payload?.layout as string | undefined) ?? "{}",
    vaultId: row.vault_id,
    hostIds: payload?.hostIds,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  isLoading: false,
  error: null,

  fetchWorkspaces: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("workspaces", vid);
      const workspaces = await Promise.all(
        rows.map((row) => workspaceFromRow(row)),
      );
      set({ workspaces, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  createWorkspace: async (name, layout, vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "workspaces",
        {
          id: newId(),
          vault_id: vid,
          name: name ?? "",
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({
            layout: JSON.stringify(layout),
            hostIds: undefined,
          }),
          recordType: "workspaces",
        },
      );
      const created: Workspace = {
        id: row.id,
        name: row.name ?? "",
        layout: JSON.stringify(layout),
        vaultId: vid,
        hostIds: undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
      set({ workspaces: [created, ...get().workspaces], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  renameWorkspace: async (id, name) => {
    set({ isLoading: true, error: null });
    try {
      const row = await getRow("workspaces", id);
      if (!row) {
        set({ isLoading: false, error: "Workspace not found" });
        return;
      }
      const payload = ((await decryptRowData(row.data)) ?? {}) as {
        layout?: string;
        hostIds?: string;
      };
      await upsertRow(
        "workspaces",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: name ?? row.name,
          sort_order: row.sort_order,
        },
        {
          plaintext: JSON.stringify({
            layout: payload.layout ?? "{}",
            hostIds: payload.hostIds,
          }),
          recordType: "workspaces",
        },
      );
      set({
        workspaces: get().workspaces.map((w) =>
          w.id === id ? { ...w, name: name ?? w.name } : w,
        ),
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  deleteWorkspace: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("workspaces", id);
      set((s) => ({
        workspaces: s.workspaces.filter((w) => w.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
