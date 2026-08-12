import { invoke } from "@tauri-apps/api/core";

export type TableName =
  | "vaults"
  | "groups"
  | "hosts"
  | "keys"
  | "snippets"
  | "workspaces"
  | "presets";

export interface SyncRow {
  id: string;
  revision: number;
  vault_id: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  name?: string;
  os?: string | null;
  auth_type?: string | null;
  tags?: string | null;
  color?: string | null;
  description?: string | null;
  key_type?: string | null;
  fingerprint?: string | null;
  public_key?: string | null;
  owner_id?: string | null;
  kind?: string | null;
  sort_order: number;
  is_default?: number;
  parent_id?: string | null;
  group_id?: string | null;
  key_id?: string | null;
  data: string;
}

export interface OutboxEntry {
  table_name: string;
  record_id: string;
  queued_at: number;
}

export async function listRows(
  table: TableName,
  vaultId: string,
  includeDeleted = false,
): Promise<SyncRow[]> {
  return invoke<SyncRow[]>("db_list", { table, vaultId, includeDeleted });
}

export async function getRow(
  table: TableName,
  id: string,
): Promise<SyncRow | null> {
  return invoke<SyncRow | null>("db_get", { table, id });
}

export async function upsertRow(
  table: TableName,
  row: { id: string; vault_id: string; data?: string } & Partial<SyncRow>,
  opts?: { plaintext?: string; recordType?: string },
): Promise<SyncRow> {
  return invoke<SyncRow>("db_upsert", {
    table,
    row,
    plaintext: opts?.plaintext,
    recordType: opts?.recordType,
  });
}

export async function deleteRow(table: TableName, id: string): Promise<void> {
  await invoke("db_delete", { table, id });
}

export async function getOutbox(): Promise<OutboxEntry[]> {
  return invoke<OutboxEntry[]>("db_outbox");
}

// Reset the on-device SQLite cache to a pristine, fresh-install state.
// Best-effort: deletes all rows from all local tables (wipe_all) so a re-open
// recreates all tables empty. Called on logout so no encrypted local rows
// remain on disk once the user signs out.
export async function wipeLocalData(): Promise<void> {
  await invoke("wipe_local_data");
}
