import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { httpRequest } from "./http";

/** A device signed in to this account, as the server lists it. */
export interface DeviceView {
  device_id: string;
  name: string;
  platform: string;
  app_version: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await httpRequest(method, path, body);
  let payload: {
    data?: T;
    error?: { code?: string; message?: string };
  } | null = null;
  try {
    payload = response.body ? JSON.parse(response.body) : null;
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (response.status >= 400)
    throw new Error(
      payload?.error?.message ?? `Request failed (${response.status}).`,
    );
  return payload?.data as T;
}

export const devicesApi = {
  list: () => request<DeviceView[]>("GET", "/api/v1/me/devices"),
  updateCurrent: (info: {
    name: string;
    platform: string;
    app_version: string;
  }) => request<void>("PUT", "/api/v1/me/devices/current", info),
  rename: (id: string, name: string) =>
    request<void>("PATCH", `/api/v1/me/devices/${encodeURIComponent(id)}`, {
      name,
    }),
  revoke: (id: string) =>
    request<void>("DELETE", `/api/v1/me/devices/${encodeURIComponent(id)}`),
  revokeOthers: () =>
    request<{ revoked: number }>("POST", "/api/v1/me/devices/revoke-others"),
};

/** Tells the server this device's name, OS and app version. Best effort: never throws. */
export async function reportDevice(): Promise<void> {
  try {
    const [info, version] = await Promise.all([
      invoke<{ name: string; platform: string }>("device_info"),
      getVersion().catch(() => ""),
    ]);
    await devicesApi.updateCurrent({
      name: info.name,
      platform: info.platform,
      app_version: version,
    });
  } catch {
    // The list falls back to "Unnamed device" until the next report.
  }
}
