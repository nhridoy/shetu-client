import { create } from "zustand";
import { runSerial } from "@/lib/common/runSerial";
import { decryptRowData } from "@/lib/crypto/crypto";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
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

interface IdentityPayload {
  username: string;
  password?: string;
  keyId?: string;
  totpSecret?: string;
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

/** Drop empty optional secrets so the payload only holds what is set. */
function compact(p: IdentityPayload): IdentityPayload {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => typeof v === "string" && v !== ""),
  ) as unknown as IdentityPayload;
}

async function readPayload(row: SyncRow): Promise<IdentityPayload> {
  return ((await decryptRowData(row.data)) ?? {}) as IdentityPayload;
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

  getDecryptedIdentity: async (id) => {
    const row = await getRow("identities", id);
    if (!row || row.deleted_at) return null;
    const p = await readPayload(row);
    return {
      username: p.username ?? "",
      keyId: p.keyId || undefined,
      hasPassword: !!p.password,
      hasTotp: !!p.totpSecret,
    };
  },

  createIdentity: async ({ vaultId, name, ...secrets }) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ error: "No vault selected" });
      return null;
    }
    try {
      const row = await upsertRow(
        "identities",
        { id: crypto.randomUUID(), vault_id: vid, name, sort_order: 0 },
        {
          plaintext: JSON.stringify(compact(secrets)),
          recordType: "identities",
        },
      );
      set({ identities: [...get().identities, fromRow(row)], error: null });
      return row.id;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  updateIdentity: (id, { name, ...patch }) =>
    runSerial(`identities:${id}`, async () => {
      try {
        const row = await getRow("identities", id);
        if (!row || row.deleted_at) {
          set({ error: "Identity not found" });
          return false;
        }
        const merged: Record<string, unknown> = { ...(await readPayload(row)) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete merged[key];
          else if (value !== undefined && value !== "") merged[key] = value;
        }
        const saved = await upsertRow(
          "identities",
          {
            id,
            vault_id: row.vault_id,
            name: name ?? row.name,
            sort_order: row.sort_order,
          },
          {
            plaintext: JSON.stringify(
              compact(merged as unknown as IdentityPayload),
            ),
            recordType: "identities",
          },
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
