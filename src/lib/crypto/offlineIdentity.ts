import { invoke } from "@tauri-apps/api/core";
import type { KeyringRows, User } from "../api/auth";

export interface OfflineIdentity {
  profile: User;
  salt_cl: string;
  wrapped_keyring: Required<KeyringRows>;
}

export async function saveOfflineIdentity(
  identity: OfflineIdentity,
): Promise<void> {
  await invoke("save_offline_identity_command", { identity });
}

export async function loadOfflineIdentity(): Promise<OfflineIdentity | null> {
  return invoke<OfflineIdentity | null>("load_offline_identity_command");
}

export async function clearOfflineIdentity(): Promise<void> {
  await invoke("clear_offline_identity_command");
}
