import { create } from "zustand";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, listRows, upsertRow } from "@/lib/db/db";
import { useAuthStore } from "@/stores/auth/authStore";

export const VAULT_KIND_PERSONAL = "personal";
export const VAULT_KIND_TEAM = "team";

interface VaultItem {
  id: string;
  name: string;
  description?: string;
  kind?: string;
  isDefault?: boolean;
  isSystem?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VaultDecryptedData {
  hosts?: unknown[];
  keys?: unknown[];
  snippets?: unknown[];
  groups?: unknown[];
  history?: unknown[];
}

interface VaultState {
  vaults: VaultItem[];
  currentVaultId: string | null;
  decryptedData: VaultDecryptedData | null;
  isLoading: boolean;
  error: string | null;

  fetchVaults: () => Promise<void>;
  createVault: (
    name: string,
    kind: string,
    description?: string,
  ) => Promise<void>;
  updateVault: (id: string, vault: Partial<VaultItem>) => Promise<void>;
  deleteVault: (id: string) => Promise<void>;
  switchVault: (vaultId: string) => Promise<void>;
  clearError: () => void;
}

function getUserId(): string {
  return useAuthStore.getState().user?.id ?? "";
}

function toVaultItem(row: SyncRow): VaultItem {
  // Only the server-seeded default vault (is_default=true, populated via sync)
  // is the system/default vault. App-created vaults always have is_default=false.
  const isSystem = Boolean(row.is_default);
  return {
    id: row.id,
    name: row.name ?? "",
    kind: row.kind ?? undefined,
    isDefault: isSystem,
    isSystem,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function vaultRow(name: string, kind: string) {
  return {
    id: crypto.randomUUID(),
    vault_id: "",
    name,
    owner_id: getUserId(),
    kind,
    sort_order: 0,
    is_default: 0,
  };
}

export const useVaultStore = create<VaultState>((set, get) => ({
  vaults: [],
  currentVaultId: null,
  decryptedData: null,
  isLoading: false,
  error: null,

  fetchVaults: async () => {
    set({ isLoading: true, error: null });
    try {
      // Vaults are per-user rows; the vault_id arg is ignored for them.
      const rows = await listRows("vaults", "");
      const vaults = rows.map(toVaultItem);
      set({ vaults, isLoading: false });

      if (!get().currentVaultId && vaults.length > 0) {
        const personal = vaults.find((v) => v.isDefault) ?? vaults[0];
        set({ currentVaultId: personal.id });
      }
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  createVault: async (name, kind, description) => {
    set({ isLoading: true, error: null });
    try {
      const row = vaultRow(name, kind);
      const saved = await upsertRow("vaults", row, {
        plaintext: "{}",
        recordType: "vaults",
      });
      const vault = { ...toVaultItem(saved), description };
      set({ vaults: [...get().vaults, vault], isLoading: false });
      set({ currentVaultId: vault.id });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  updateVault: async (id, vault) => {
    set({ isLoading: true, error: null });
    try {
      const existing = get().vaults.find((v) => v.id === id);
      if (!existing) {
        set({ isLoading: false });
        return;
      }
      const saved = await upsertRow(
        "vaults",
        {
          id,
          vault_id: "",
          name: vault.name ?? existing.name,
          owner_id: getUserId(),
          kind: vault.kind ?? existing.kind ?? VAULT_KIND_TEAM,
          sort_order: 0,
          is_default: existing.isDefault ? 1 : 0,
        },
        { plaintext: "{}", recordType: "vaults" },
      );
      const updated = {
        ...toVaultItem(saved),
        description: vault.description ?? existing.description,
      };
      set({
        vaults: get().vaults.map((v) => (v.id === id ? updated : v)),
        isLoading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  deleteVault: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("vaults", id);
      const { vaults, currentVaultId } = get();
      const newVaults = vaults.filter((v) => v.id !== id);
      let newCurrentVaultId = currentVaultId;

      if (currentVaultId === id) {
        newCurrentVaultId = newVaults[0]?.id ?? null;
      }

      set({
        vaults: newVaults,
        currentVaultId: newCurrentVaultId,
        isLoading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  switchVault: async (vaultId) => {
    set({
      currentVaultId: vaultId,
      decryptedData: null,
      error: null,
    });
  },

  clearError: () => set({ error: null }),
}));
