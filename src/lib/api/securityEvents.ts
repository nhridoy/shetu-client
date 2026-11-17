import { apiFetch } from "./auth";

/** One entry in the account's security history. Failed attempts come grouped (count, ip_count). */
export interface SecurityEvent {
  id: number;
  kind: string;
  detail: string;
  /** From the device list at read time; empty when unknown. */
  device_name: string;
  platform: string;
  ip: string;
  count: number;
  ip_count: number;
  created_at: string;
  last_at: string;
  current_device: boolean;
}

export const securityEventsApi = {
  /** Newest first; pass the previous page's `next` to continue. */
  list: (before?: number) =>
    apiFetch<{ events: SecurityEvent[]; next: number | null }>(
      "GET",
      before === undefined
        ? "/api/v1/me/security-events"
        : `/api/v1/me/security-events?before=${before}`,
    ),
};
