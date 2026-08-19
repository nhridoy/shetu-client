import { create } from "zustand";
import { decryptRowData } from "@/lib/crypto/crypto";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Key {
  id: string;
  name: string;
  description?: string;
  keyType: string;
  publicKey: string;
  encryptedPrivateKey: string;
  fingerprint?: string;
  createdAt: string;
  /** @internal encrypted payload blob — kept for on-demand decrypt, never render */
  data?: string;
}

interface KeyState {
  keys: Key[];
  selectedKey: Key | null;
  isLoading: boolean;
  error: string | null;

  fetchKeys: (vaultId?: string) => Promise<void>;
  selectKey: (key: Key | null) => void;
  getDecryptedKey: (keyId: string) => Promise<Key | null>;
  importKey: (key: Partial<Key>) => Promise<void>;
  generateKey: (name: string, keyType: string) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;
  getCredentialsForKey: (keyId: string) => Promise<string>;
  clearError: () => void;
}

interface KeyPayload {
  privateKey: string;
  passphrase?: string;
}

function newId(): string {
  return crypto.randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List-safe mapping: reads plaintext columns only, no decryption.
 * encryptedPrivateKey stays empty until on-demand decrypt. */
function keyFromRow(row: SyncRow): Key {
  return {
    id: row.id,
    name: row.name ?? "",
    description: row.description ?? undefined,
    keyType: row.key_type ?? "ed25519",
    publicKey: row.public_key ?? "",
    encryptedPrivateKey: "",
    fingerprint: row.fingerprint ?? undefined,
    createdAt: String(row.created_at),
    data: row.data ?? "",
  };
}

/** Full key with the (already-wrapped) private key — decrypt on demand. */
async function decryptKeyRow(row: SyncRow): Promise<Key> {
  const payload = ((await decryptRowData(row.data)) ??
    {}) as Partial<KeyPayload>;
  return {
    ...keyFromRow(row),
    encryptedPrivateKey: payload.privateKey ?? "",
  };
}

export const useKeyStore = create<KeyState>((set, get) => ({
  keys: [],
  selectedKey: null,
  isLoading: false,
  error: null,

  fetchKeys: async (vaultId) => {
    const vid = vaultId ?? useVaultStore.getState().currentVaultId;
    if (!vid) {
      set({ isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const rows = await listRows("keys", vid);
      const keys = rows.map((row) => keyFromRow(row));
      set({ keys, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  selectKey: (key) => set({ selectedKey: key }),

  getDecryptedKey: async (keyId) => {
    const cached = get().keys.find((k) => k.id === keyId);
    if (cached?.data) {
      const payload = ((await decryptRowData(cached.data)) ??
        {}) as Partial<KeyPayload>;
      return { ...cached, encryptedPrivateKey: payload.privateKey ?? "" };
    }
    const row = await getRow("keys", keyId);
    if (!row) {
      return null;
    }
    return decryptKeyRow(row);
  },

  importKey: async (key) => {
    const vaultId = useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "keys",
        {
          id: key.id ?? newId(),
          vault_id: vaultId,
          name: key.name ?? "",
          description: key.description ?? null,
          key_type: key.keyType ?? "ed25519",
          fingerprint: key.fingerprint ?? null,
          public_key: key.publicKey ?? null,
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({
            privateKey: key.encryptedPrivateKey ?? "",
            passphrase: undefined,
          }),
          recordType: "keys",
        },
      );
      const created: Key = {
        id: row.id,
        name: row.name ?? "",
        description: row.description ?? undefined,
        keyType: key.keyType ?? "ed25519",
        publicKey: key.publicKey ?? "",
        encryptedPrivateKey: "",
        fingerprint: key.fingerprint,
        createdAt: String(row.created_at),
      };
      set({ keys: [created, ...get().keys], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  generateKey: async (name, keyType) => {
    const vaultId = useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      set({ isLoading: false, error: "No vault selected" });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const row = await upsertRow(
        "keys",
        {
          id: newId(),
          vault_id: vaultId,
          name: name ?? "",
          description: null,
          key_type: keyType ?? "ed25519",
          fingerprint: null,
          public_key: null,
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({
            privateKey: "",
            passphrase: undefined,
          }),
          recordType: "keys",
        },
      );
      const created: Key = {
        id: row.id,
        name: row.name ?? "",
        keyType: keyType ?? "ed25519",
        publicKey: "",
        encryptedPrivateKey: "",
        createdAt: String(row.created_at),
      };
      set({ keys: [created, ...get().keys], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  deleteKey: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteRow("keys", id);
      set((s) => ({
        keys: s.keys.filter((k) => k.id !== id),
        selectedKey: s.selectedKey?.id === id ? null : s.selectedKey,
        isLoading: false,
      }));
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
    }
  },

  getCredentialsForKey: async (keyId) => {
    const cached = get().keys.find((k) => k.id === keyId);
    let data = cached?.data;
    if (data == null) {
      const row = await getRow("keys", keyId);
      if (!row) {
        return "";
      }
      data = row.data;
    }
    const payload = ((await decryptRowData(data)) ?? {}) as Partial<KeyPayload>;
    return payload.privateKey ?? "";
  },

  clearError: () => set({ error: null }),
}));
