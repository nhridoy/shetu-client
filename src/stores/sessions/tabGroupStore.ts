import { create } from "zustand";
import { decryptRowData } from "@/lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import type { PaneNode } from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface TabGroup {
  id: string;
  name: string;
  layout: string;
  vaultId?: string;
  createdAt?: string;
}

interface TabGroupState {
  tabGroups: TabGroup[];
  error: string | null;
  fetchTabGroups: (vaultId?: string) => Promise<void>;
  createTabGroup: (
    name: string,
    root: PaneNode,
    vaultId?: string,
  ) => Promise<TabGroup | null>;
  updateTabGroup: (id: string, root: PaneNode) => Promise<void>;
  renameTabGroup: (id: string, name: string) => Promise<void>;
  deleteTabGroup: (id: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useTabGroupStore = create<TabGroupState>((set, get) => ({
  tabGroups: [],
  error: null,

  fetchTabGroups: async (vaultId) => {
    const selectedVaultId = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!selectedVaultId) {
      set({ tabGroups: [], error: null });
      return;
    }
    try {
      const rows = await listRows("presets", selectedVaultId);
      const tabGroups = await Promise.all(
        rows.map(async (row) => {
          const payload = (await decryptRowData(row.data)) as {
            layout?: string;
          } | null;
          return {
            id: row.id,
            name: row.name ?? "",
            layout: payload?.layout ?? "{}",
            vaultId: row.vault_id,
            createdAt: String(row.created_at),
          };
        }),
      );
      set({ tabGroups, error: null });
    } catch (error) {
      set({ tabGroups: [], error: errorMessage(error) });
    }
  },

  createTabGroup: async (name, root, vaultId) => {
    const selectedVaultId = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!selectedVaultId) {
      set({ error: "No vault selected" });
      return null;
    }
    try {
      const layout = JSON.stringify(root);
      const row = await upsertRow(
        "presets",
        {
          id: crypto.randomUUID(),
          vault_id: selectedVaultId,
          name,
          sort_order: 0,
        },
        { plaintext: JSON.stringify({ layout }), recordType: "presets" },
      );
      const created = {
        id: row.id,
        name: row.name ?? name,
        layout,
        vaultId: row.vault_id,
        createdAt: String(row.created_at),
      };
      set({ tabGroups: [created, ...get().tabGroups], error: null });
      return created;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  updateTabGroup: async (id, root) => {
    try {
      const row = await getRow("presets", id);
      if (!row) throw new Error("Preset not found");
      const layout = JSON.stringify(root);
      await upsertRow(
        "presets",
        {
          id: row.id,
          vault_id: row.vault_id,
          name: row.name,
          sort_order: row.sort_order,
        },
        { plaintext: JSON.stringify({ layout }), recordType: "presets" },
      );
      set({
        tabGroups: get().tabGroups.map((preset) =>
          preset.id === id ? { ...preset, layout } : preset,
        ),
        error: null,
      });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  renameTabGroup: async (id, name) => {
    try {
      const row = await getRow("presets", id);
      if (!row) throw new Error("Preset not found");
      const payload = (await decryptRowData(row.data)) as {
        layout?: string;
      } | null;
      await upsertRow(
        "presets",
        {
          id: row.id,
          vault_id: row.vault_id,
          name,
          sort_order: row.sort_order,
        },
        {
          plaintext: JSON.stringify({ layout: payload?.layout ?? "{}" }),
          recordType: "presets",
        },
      );
      set({
        tabGroups: get().tabGroups.map((preset) =>
          preset.id === id ? { ...preset, name } : preset,
        ),
        error: null,
      });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  deleteTabGroup: async (id) => {
    try {
      await deleteRow("presets", id);
      set({
        tabGroups: get().tabGroups.filter((preset) => preset.id !== id),
        error: null,
      });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },
}));
