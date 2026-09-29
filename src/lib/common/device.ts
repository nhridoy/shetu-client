import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

const AUTH_SETTINGS_FILE = "auth.json";
const DEVICE_ID_KEY = "deviceId";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cachedDeviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const store = await load(AUTH_SETTINGS_FILE, { autoSave: false });
    let id = await store.get<string>(DEVICE_ID_KEY);
    // Preserve the ID existing sessions and refresh tokens were issued for.
    if (!id || !UUID.test(id)) {
      id = crypto.randomUUID();
      await store.set(DEVICE_ID_KEY, id);
      await store.save();
    }
    cachedDeviceId = id;
    return id;
  } catch {
    // The Rust fallback is also a persisted UUID. Never share a fixed ID.
    const id = await invoke<string>("get_device_id");
    if (!UUID.test(id)) throw new Error("Invalid persisted device ID");
    cachedDeviceId = id;
    return id;
  }
}

export async function setUserId(_userId: string): Promise<void> {}
