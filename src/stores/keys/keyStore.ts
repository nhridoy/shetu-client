import { invoke } from "@tauri-apps/api/core";
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
  passphrase?: string;
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
  generateKey: (
    name: string,
    keyType: string,
    description?: string,
  ) => Promise<Key>;
  deleteKey: (id: string) => Promise<void>;
  getCredentialsForKey: (keyId: string) => Promise<string>;
  clearError: () => void;
}

interface KeyPayload {
  privateKey: string;
  passphrase?: string;
}

interface KeyMetadata {
  key_type: string;
  public_key: string;
  fingerprint: string;
}

interface GeneratedKey extends KeyMetadata {
  private_key: string;
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
      const error = new Error("No vault selected");
      set({ isLoading: false, error: error.message });
      throw error;
    }
    set({ isLoading: true, error: null });
    try {
      if (!key.encryptedPrivateKey?.trim()) {
        throw new Error("Private key is required");
      }
      const metadata = await invoke<KeyMetadata>("inspect_private_key", {
        privateKey: key.encryptedPrivateKey,
        passphrase: key.passphrase || null,
      });
      const publicKey = metadata.public_key;
      if (
        key.publicKey?.trim() &&
        key.publicKey.trim().split(/\s+/).slice(0, 2).join(" ") !==
          publicKey.split(/\s+/).slice(0, 2).join(" ")
      ) {
        throw new Error("Public key does not match the private key");
      }
      const row = await upsertRow(
        "keys",
        {
          id: key.id ?? newId(),
          vault_id: vaultId,
          name: key.name ?? "",
          description: key.description ?? null,
          key_type: metadata.key_type,
          fingerprint: metadata.fingerprint,
          public_key: publicKey || null,
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({
            privateKey: key.encryptedPrivateKey ?? "",
            passphrase: key.passphrase || undefined,
          }),
          recordType: "keys",
        },
      );
      const created: Key = {
        id: row.id,
        name: row.name ?? "",
        description: row.description ?? undefined,
        keyType: metadata.key_type,
        publicKey,
        encryptedPrivateKey: "",
        fingerprint: metadata.fingerprint,
        createdAt: String(row.created_at),
      };
      set({ keys: [created, ...get().keys], isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
      throw err;
    }
  },

  generateKey: async (name, keyType, description) => {
    const vaultId = useVaultStore.getState().currentVaultId;
    if (!vaultId) {
      const error = new Error("No vault selected");
      set({ error: error.message });
      throw error;
    }
    set({ isLoading: true, error: null });
    try {
      const generated = await invoke<GeneratedKey>("generate_ssh_key", {
        keyType,
      });
      const row = await upsertRow(
        "keys",
        {
          id: newId(),
          vault_id: vaultId,
          name,
          description: description || null,
          key_type: generated.key_type,
          fingerprint: generated.fingerprint,
          public_key: generated.public_key,
          sort_order: 0,
        },
        {
          plaintext: JSON.stringify({ privateKey: generated.private_key }),
          recordType: "keys",
        },
      );
      const created: Key = {
        id: row.id,
        name,
        description,
        keyType: generated.key_type,
        publicKey: generated.public_key,
        encryptedPrivateKey: generated.private_key,
        fingerprint: generated.fingerprint,
        createdAt: String(row.created_at),
      };
      set({
        keys: [{ ...created, encryptedPrivateKey: "" }, ...get().keys],
        isLoading: false,
      });
      return created;
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err) });
      throw err;
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
