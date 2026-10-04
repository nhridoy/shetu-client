import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth/authStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface SessionHistoryItem {
  id: string;
  vault_id: string;
  host_id: string;
  host_label: string;
  connection_type: "ssh" | "local";
  state: "connecting" | "connected" | "ended" | "failed" | "interrupted";
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  reason: string | null;
  recording: boolean;
  truncated: boolean;
}

interface SessionState {
  sessions: SessionHistoryItem[];
  selectedSession: SessionHistoryItem | null;
  output: string;
  isLoading: boolean;
  error: string | null;
  retentionDays: 7 | 30 | 90;
  fetchSessions: (hostId?: string) => Promise<void>;
  selectSession: (session: SessionHistoryItem | null) => void;
  fetchLogs: (sessionId: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setRetentionDays: (days: 7 | 30 | 90) => Promise<void>;
  clear: () => void;
  clearError: () => void;
}

function personalVaultId(): string {
  const vault = useVaultStore
    .getState()
    .vaults.find((item) => item.isDefault && !item.isShared);
  if (!vault) throw new Error("Default personal vault unavailable");
  return vault.id;
}

function notifyMutation(vaultId: string) {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("terra:local-mutation", { detail: { vaultId } }),
    );
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  selectedSession: null,
  output: "",
  isLoading: false,
  error: null,
  retentionDays: 30,

  fetchSessions: async (hostId) => {
    set({ isLoading: true, error: null });
    try {
      const vaultId = personalVaultId();
      const recovered = await invoke<number>("history_recover_interrupted", {
        vaultId,
      });
      const retentionDays = await invoke<7 | 30 | 90>("history_get_retention", {
        vaultId,
      });
      const expired = await invoke<number>("history_apply_retention", {
        vaultId,
      });
      if (recovered > 0 || expired > 0) notifyMutation(vaultId);
      const sessions = await invoke<SessionHistoryItem[]>("history_list", {
        vaultId,
      });
      set({
        sessions: hostId
          ? sessions.filter((session) => session.host_id === hostId)
          : sessions,
        retentionDays,
        isLoading: false,
      });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  selectSession: (session) =>
    set({ selectedSession: session, output: "", error: null }),
  fetchLogs: async (sessionId) => {
    set({ isLoading: true, error: null });
    try {
      const output = await invoke<string>("history_get_output", {
        vaultId: personalVaultId(),
        attemptId: sessionId,
      });
      if (get().selectedSession?.id === sessionId)
        set({ output, isLoading: false });
      else set({ isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  deleteSession: async (id) => {
    set({ error: null });
    try {
      const vaultId = personalVaultId();
      await invoke("history_delete", {
        vaultId,
        attemptId: id,
      });
      notifyMutation(vaultId);
      set({
        sessions: get().sessions.filter((session) => session.id !== id),
        selectedSession:
          get().selectedSession?.id === id ? null : get().selectedSession,
        output: get().selectedSession?.id === id ? "" : get().output,
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  setRetentionDays: async (days) => {
    set({ error: null });
    try {
      const vaultId = personalVaultId();
      await invoke("history_set_retention", { vaultId, days });
      notifyMutation(vaultId);
      set({ retentionDays: days });
      await get().fetchSessions();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  clear: () =>
    set({ sessions: [], selectedSession: null, output: "", error: null }),
  clearError: () => set({ error: null }),
}));

useAuthStore.subscribe((state, previous) => {
  if (
    !state.isUnlocked ||
    state.localAccessAccountId !== previous.localAccessAccountId
  ) {
    useSessionStore.getState().clear();
  }
});
