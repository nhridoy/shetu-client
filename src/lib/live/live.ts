import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Emitted by the Rust live stream when it comes up or goes down. */
export const LIVE_STATUS_EVENT = "live://status";
/** Emitted for each server signal: changed, device_revoked, account_changed. */
export const LIVE_SIGNAL_EVENT = "live://event";

export type LiveStatus = "connected" | "disconnected";

/** Opens (or reopens) the live stream for the current server session. */
export const startLive = () => invoke("live_start");
/** Closes the live stream. */
export const stopLive = () => invoke("live_stop");

// Outside the app (tests, previews) there is no Tauri event bus: listening is a no-op there.
export function onLiveStatus(cb: (status: LiveStatus) => void): void {
  void listen<LiveStatus>(LIVE_STATUS_EVENT, (e) => cb(e.payload)).catch(
    () => {},
  );
}

export function onLiveSignal(cb: (kind: string) => void): void {
  void listen<{ kind: string }>(LIVE_SIGNAL_EVENT, (e) =>
    cb(e.payload.kind),
  ).catch(() => {});
}
