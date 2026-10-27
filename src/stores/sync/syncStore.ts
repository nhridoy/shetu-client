import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { triggerSync } from "../../lib/api/sync";
import { getOutbox } from "../../lib/db/db";
import { useAuthStore } from "../auth/authStore";
import { useVaultStore } from "../vault/vaultStore";

export const SYNC_COMPLETED_EVENT = "terra:sync-completed";
export const TEAM_SYNC_COMPLETED_EVENT = "terra:team-sync-completed";
export const TEAM_ACCESS_REVOKED_EVENT = "terra:team-access-revoked";

export type SyncState =
  | "local-only"
  | "pending"
  | "syncing"
  | "synced"
  | "offline"
  | "auth-required"
  | "access-denied"
  | "error";

interface SyncStore {
  state: SyncState;
  pendingCount: number;
  lastSyncAt: string | null;
  error: string | null;
  requestSync: (vaultId: string) => Promise<void>;
  retry: (vaultId: string) => Promise<void>;
  requestAll: () => Promise<void>;
  notifyLocalMutation: (vaultId: string) => void;
  start: (vaultId: string) => () => void;
}

const inFlight = new Map<string, Promise<void>>();
const teamSyncInFlight = new Map<string, Promise<void>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeVaultId: string | null = null;

async function requestTeamSync(throwOnError = false): Promise<void> {
  const auth = useAuthStore.getState();
  const accountId = auth.localAccessAccountId ?? auth.user?.id;
  if (!accountId) {
    if (throwOnError) throw new Error("Sign in to sync team changes.");
    return;
  }
  const existing = teamSyncInFlight.get(accountId);
  if (existing) {
    try {
      await existing;
    } catch (error) {
      if (throwOnError) throw error;
      console.warn("Team sync deferred:", error);
    }
    return;
  }
  const task = (async () => {
    const currentAuth = useAuthStore.getState();
    if (!currentAuth.serverAuthenticated) {
      const result = await currentAuth.retryServerSession();
      if (result !== "connected") {
        if (throwOnError)
          throw new Error(`Team sync requires a connection: ${result}`);
        return;
      }
    }
    const summary = await invoke<{ rotatedVaultIds?: string[] }>(
      "team_sync_now",
      { accountId },
    );
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent(TEAM_SYNC_COMPLETED_EVENT, { detail: summary }),
      );
  })();
  teamSyncInFlight.set(accountId, task);
  try {
    await task;
  } catch (error) {
    // Team data remains available from SQLite; a later timer or reconnect retries.
    console.warn("Team sync deferred:", error);
    if (throwOnError) throw error;
  } finally {
    teamSyncInFlight.delete(accountId);
  }
}

export function notifyTeamMutation(): void {
  void requestTeamSync();
}

export function syncTeamsNow(): Promise<void> {
  return requestTeamSync(true);
}

async function countPending(): Promise<number> {
  try {
    return (await getOutbox()).length;
  } catch {
    return 0;
  }
}

function classifyFailure(error: unknown): SyncState {
  const message = String(error).toLowerCase();
  if (
    message.includes("server-error-403") ||
    message.includes("team vault access revoked")
  )
    return "access-denied";
  if (
    message.includes("network:") ||
    message.includes("offline") ||
    message.includes("connect")
  )
    return "offline";
  if (
    message.includes("auth") ||
    message.includes("401") ||
    message.includes("session")
  )
    return "auth-required";
  return "error";
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  state: "local-only",
  pendingCount: 0,
  lastSyncAt: null,
  error: null,

  requestSync: (vaultId) => {
    const existing = inFlight.get(vaultId);
    if (existing) return existing;
    const task = (async () => {
      const pendingBefore = await countPending();
      const auth = useAuthStore.getState();
      if (!auth.localAccessAccountId) {
        set({ state: "local-only", pendingCount: pendingBefore });
        return;
      }
      if (!auth.serverAuthenticated) {
        const result = await auth.retryServerSession();
        if (result !== "connected") {
          set({ state: result, pendingCount: pendingBefore });
          return;
        }
      }
      set({ state: "syncing", pendingCount: pendingBefore, error: null });
      try {
        const report = await triggerSync(vaultId);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(SYNC_COMPLETED_EVENT, { detail: { vaultId } }),
          );
        }
        const pendingAfter = await countPending();
        const pendingCount = Math.max(report.pending, pendingAfter);
        set({
          state: pendingCount ? "pending" : "synced",
          pendingCount,
          lastSyncAt: report.last_sync_at,
          error: null,
        });
      } catch (error) {
        if (
          typeof window !== "undefined" &&
          String(error).includes("server-error-403")
        ) {
          window.dispatchEvent(
            new CustomEvent(TEAM_ACCESS_REVOKED_EVENT, {
              detail: { vaultId },
            }),
          );
        }
        const pendingCount = await countPending();
        set({
          state: classifyFailure(error),
          pendingCount,
          error: String(error),
        });
      }
    })();
    inFlight.set(vaultId, task);
    void task.finally(() => inFlight.delete(vaultId));
    return task;
  },

  retry: (vaultId) => get().requestSync(vaultId),

  requestAll: async () => {
    const vaultIds = new Set(
      useVaultStore.getState().vaults.map((vault) => vault.id),
    );
    if (activeVaultId) vaultIds.add(activeVaultId);
    await Promise.allSettled(
      [...vaultIds].map((vaultId) => get().requestSync(vaultId)),
    );
    await requestTeamSync();
  },

  notifyLocalMutation: (vaultId) => {
    set((state) => ({
      state: "pending",
      pendingCount: Math.max(1, state.pendingCount),
    }));
    const previous = debounceTimers.get(vaultId);
    if (previous) clearTimeout(previous);
    debounceTimers.set(
      vaultId,
      setTimeout(() => {
        debounceTimers.delete(vaultId);
        void get().requestSync(vaultId);
      }, 750),
    );
  },

  start: (vaultId) => {
    activeVaultId = vaultId;
    void get().requestAll();
    if (typeof window === "undefined") return () => {};
    const onMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ vaultId?: string }>).detail;
      get().notifyLocalMutation(detail?.vaultId || activeVaultId || vaultId);
    };
    const onOnline = () => void get().requestAll();
    window.addEventListener("terra:local-mutation", onMutation);
    window.addEventListener("online", onOnline);
    const interval = setInterval(() => void get().requestAll(), 30_000);
    return () => {
      window.removeEventListener("terra:local-mutation", onMutation);
      window.removeEventListener("online", onOnline);
      clearInterval(interval);
      if (activeVaultId === vaultId) activeVaultId = null;
    };
  },
}));
