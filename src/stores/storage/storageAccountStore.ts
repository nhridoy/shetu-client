import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDeviceId } from "@/lib/common/device";
import type { SyncRow } from "@/lib/db/db";
import { deleteRow, listRows, notifyLocalMutation } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";

export type StorageProvider =
  | "aws"
  | "r2"
  | "b2"
  | "wasabi"
  | "spaces"
  | "custom"
  | "webdav";

/** List entry: plaintext columns only. Secrets never live in store state. */
export interface StorageAccount {
  id: string;
  name: string;
  vaultId: string;
}

/** What the account form may see of a saved account: everything but the secret key. */
export interface StorageAccountView {
  provider: StorageProvider;
  endpoint: string | null;
  region: string;
  bucket: string;
  pathStyle: boolean;
  r2AccountId: string | null;
  accessKeyId: string;
  webdavKind?: "nextcloud" | "other" | null;
  server?: string | null;
  url?: string | null;
  username?: string | null;
  trustedCertSha256?: string | null;
  hasSecret: boolean;
}

/** Form changes. A text field that is absent or `""` keeps the stored value. */
export type StorageAccountPatch = Partial<{
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  r2AccountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  webdavKind: "nextcloud" | "other";
  server: string;
  url: string;
  username: string;
  password: string;
  /** `null` forgets a trusted certificate. */
  trustedCertSha256: string | null;
}>;

interface StorageAccountState {
  accounts: StorageAccount[];
  error: string | null;
  fetchStorageAccounts: (vaultId?: string) => Promise<void>;
  view: (id: string) => Promise<StorageAccountView | null>;
  save: (
    id: string | null,
    name: string,
    patch: StorageAccountPatch,
  ) => Promise<boolean>;
  test: (id: string | null, patch: StorageAccountPatch) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const fromRow = (row: SyncRow): StorageAccount => ({
  id: row.id,
  name: row.name ?? "",
  vaultId: row.vault_id,
});

export const useStorageAccountStore = create<StorageAccountState>(
  (set, get) => ({
    accounts: [],
    error: null,

    fetchStorageAccounts: async (vaultId) => {
      const vid = vaultId ?? useVaultStore.getState().currentVaultId;
      // Another vault's (or no vault's) accounts are never shown, even if this fetch fails.
      if (!vid || get().accounts.some((a) => a.vaultId !== vid))
        set({ accounts: [] });
      if (!vid) return;
      try {
        const rows = await listRows("storage_accounts", vid);
        // A vault switch meanwhile wins.
        if (vid !== useVaultStore.getState().currentVaultId) return;
        set({ accounts: rows.map(fromRow), error: null });
      } catch (err) {
        set({ error: message(err) });
      }
    },

    view: (id) =>
      invoke<StorageAccountView | null>("storage_account_view", { id }),

    save: async (id, name, patch) => {
      const current = id ? get().accounts.find((a) => a.id === id) : undefined;
      const vaultId =
        current?.vaultId ?? useVaultStore.getState().currentVaultId;
      if (!vaultId) {
        set({ error: "No vault selected" });
        return false;
      }
      try {
        // Rust merges, validates and encrypts; the secret never comes back.
        const row = await invoke<SyncRow>("storage_account_save", {
          id,
          vaultId,
          name,
          patch,
          deviceId: await getDeviceId(),
        });
        notifyLocalMutation("storage_accounts", row.vault_id);
        // The user moved to another vault meanwhile: its list isn't this account's.
        if (row.vault_id !== useVaultStore.getState().currentVaultId)
          return true;
        const saved = fromRow(row);
        set({
          accounts: id
            ? get().accounts.map((a) => (a.id === id ? saved : a))
            : [...get().accounts, saved],
          error: null,
        });
        return true;
      } catch (err) {
        set({ error: message(err) });
        return false;
      }
    },

    test: (id, patch) => invoke<string>("storage_test", { id, patch }),

    remove: async (id) => {
      try {
        await deleteRow("storage_accounts", id);
        set({
          accounts: get().accounts.filter((a) => a.id !== id),
          error: null,
        });
      } catch (err) {
        set({ error: message(err) });
      }
    },
  }),
);
