import { create } from "zustand";
import { useHostStore } from "./hostStore";

export type PingStatus = "pinging" | "reachable" | "unreachable";

export interface PingState {
  status: PingStatus;
  latencyMs?: number;
  os?: string;
}

interface HostPingState {
  pings: Record<string, PingState>;
  ping: (hostId: string) => Promise<void>;
  clear: (hostId?: string) => void;
}

export const useHostPingStore = create<HostPingState>((set) => ({
  pings: {},
  ping: async (hostId) => {
    set((s) => ({ pings: { ...s.pings, [hostId]: { status: "pinging" } } }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const hostStore = useHostStore.getState();
      const host = await hostStore.getDecryptedHost(hostId);
      if (!host?.address) {
        set((s) => ({
          pings: { ...s.pings, [hostId]: { status: "unreachable" } },
        }));
        return;
      }
      const creds = await hostStore.getCredentialsForHost(hostId);
      const result = await invoke<{
        reachable: boolean;
        latency_ms: number | null;
        os: string | null;
      }>("ping_host", {
        config: {
          host: host.address,
          port: host.port,
          username: host.username ?? "root",
          password: creds.password,
          privateKey: creds.privateKey,
          passphrase: creds.passphrase,
        },
      });
      if (result.reachable) {
        if (result.os) {
          void hostStore.updateHostOs(hostId, result.os);
        }
        set((s) => ({
          pings: {
            ...s.pings,
            [hostId]: {
              status: "reachable",
              latencyMs: result.latency_ms ?? undefined,
              os: result.os ?? undefined,
            },
          },
        }));
      } else {
        set((s) => ({
          pings: { ...s.pings, [hostId]: { status: "unreachable" } },
        }));
      }
    } catch {
      set((s) => ({
        pings: { ...s.pings, [hostId]: { status: "unreachable" } },
      }));
    }
  },
  clear: (hostId) =>
    set((s) => {
      if (!hostId) return { pings: {} };
      const { [hostId]: _removed, ...rest } = s.pings;
      return { pings: rest };
    }),
}));
