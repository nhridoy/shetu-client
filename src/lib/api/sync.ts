import { invoke } from "@tauri-apps/api/core";
import { getDeviceId } from "../common/device";

export interface SyncReport {
  pending: number;
  last_sync_at: string | null;
  cursor: number;
}

export async function triggerSync(vaultId: string): Promise<SyncReport> {
  return invoke<SyncReport>("sync_now", {
    vaultId,
    deviceId: await getDeviceId(),
  });
}
