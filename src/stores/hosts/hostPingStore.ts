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
      const hostOs = useHostStore
        .getState()
        .hosts.find((h) => h.id === hostId)?.os;
      const result = await invoke<{
        reachable: boolean;
        latency_ms: number | null;
        os: string | null;
      }>("ping_host_saved", { hostId, detectOs: !hostOs });
      if (result.reachable) {
        if (result.os) {
          void useHostStore.getState().updateHostOs(hostId, result.os);
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
