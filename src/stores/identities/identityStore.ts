import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDeviceId } from "@/lib/common/device";
import { runSerial } from "@/lib/common/runSerial";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, listRows, notifyLocalMutation } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";

/** List entry: plaintext columns only. Secrets never live in store state. */
export interface Identity {
  id: string;
  name: string;
  vaultId: string;
  sortOrder: number;
  createdAt: string;
}

/** What the edit form may see of a saved identity. */
export interface IdentityView {
  username: string;
  keyId?: string;
  hasPassword: boolean;
  hasTotp: boolean;
}

export interface NewIdentity {
  name: string;
  username: string;
  password?: string;
  keyId?: string;
  totpSecret?: string;
  vaultId?: string;
}

/** `""` keeps a stored password/TOTP (masked fields), `null` clears it. */
export interface IdentityPatch {
  name?: string;
  username?: string;
  password?: string | null;
  keyId?: string | null;
  totpSecret?: string | null;
}

interface IdentityState {
  identities: Identity[];
  isLoading: boolean;
  error: string | null;
  fetchIdentities: (vaultId?: string) => Promise<void>;
  getDecryptedIdentity: (id: string) => Promise<IdentityView | null>;
  createIdentity: (identity: NewIdentity) => Promise<string | null>;
  updateIdentity: (id: string, patch: IdentityPatch) => Promise<boolean>;
  deleteIdentity: (id: string) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fromRow(row: SyncRow): Identity {
  return {
    id: row.id,
    name: row.name ?? "",
    vaultId: row.vault_id,
    sortOrder: row.sort_order ?? 0,
    createdAt: String(row.created_at),
  };
}

/** Rust merges the patch and encrypts; secrets never come back to the webview. */
async function saveIdentity(
  id: string | null,
  vaultId: string,
  name: string,
  patch: Record<string, string | null | undefined>,
): Promise<SyncRow> {
  const saved = await invoke<SyncRow>("identity_save", {
    id,
    vaultId,
    name,
    patch,
    deviceId: await getDeviceId(),
  });
  notifyLocalMutation("identities", saved.vault_id);
  return saved;
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  identities: [],
  isLoading: false,
  error: null,

  fetchIdentities: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) return;
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("identities", vid);
      set({ identities: rows.map(fromRow), isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  getDecryptedIdentity: (id) =>
    invoke<IdentityView | null>("identity_view", { id }),

  createIdentity: async ({ vaultId, name, ...secrets }) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ error: "No vault selected" });
      return null;
    }
    try {
      const row = await saveIdentity(null, vid, name, { ...secrets });
      set({ identities: [...get().identities, fromRow(row)], error: null });
      return row.id;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  updateIdentity: (id, { name, ...patch }) =>
    runSerial(`identities:${id}`, async () => {
      const current = get().identities.find((i) => i.id === id);
      try {
        // Rust keeps the row's own vault; the name falls back to the listed one.
        const saved = await saveIdentity(
          id,
          current?.vaultId ?? "",
          name ?? current?.name ?? "",
          { ...patch },
        );
        set({
          identities: get().identities.map((i) =>
            i.id === id ? fromRow(saved) : i,
          ),
          error: null,
        });
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    }),

  deleteIdentity: async (id) => {
    try {
      await deleteRow("identities", id);
      set({
        identities: get().identities.filter((i) => i.id !== id),
        error: null,
      });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },
}));
