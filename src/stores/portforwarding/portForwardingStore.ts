import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { getDeviceId } from "@/lib/common/device";
import type { PortForwardFormSchema } from "@/lib/schema/portforwarding/portForwardFormSchema";
import { useHostStore } from "@/stores/hosts/hostStore";

export type ForwardMode = "local" | "remote" | "dynamic";
export type ForwardStatus = {
  state: "stopped" | "starting" | "active" | "failed";
  error?: string;
};

export interface ForwardDefinition {
  id: string;
  hostId: string;
  mode: ForwardMode;
  name: string;
  localPort: number | null;
  remoteBindAddress: string | null;
  remotePort: number | null;
  destinationHost: string | null;
  destinationPort: number | null;
}

export interface ForwardView {
  definition: ForwardDefinition;
  status: ForwardStatus;
}

export type PortForward = ForwardDefinition & {
  status: ForwardStatus;
};

export type ForwardInput = Omit<ForwardDefinition, "id">;

interface ForwardStatusEvent {
  id: string;
  status: ForwardStatus;
}

interface PortForwardingState {
  hostId: string | null;
  forwards: PortForward[];
  isLoading: boolean;
  error: string | null;
  busyIds: string[];
  loadForwards: (hostId: string) => Promise<void>;
  createForward: (input: ForwardInput) => Promise<PortForward>;
  updateForward: (id: string, input: ForwardInput) => Promise<PortForward>;
  deleteForward: (id: string) => Promise<void>;
  startForward: (id: string, ownerPaneId: string) => Promise<PortForward>;
  stopForward: (id: string) => Promise<PortForward>;
  clearError: () => void;
}

const toForward = (view: ForwardView): PortForward => ({
  ...view.definition,
  status: view.status,
});

export function toForwardInput(
  hostId: string,
  form: PortForwardFormSchema,
): ForwardInput {
  return {
    hostId,
    mode: form.mode,
    name: form.name.trim(),
    localPort: form.mode === "remote" ? null : form.localPort,
    remoteBindAddress: form.mode === "remote" ? form.remoteBindAddress : null,
    remotePort: form.mode === "remote" ? form.remotePort : null,
    destinationHost:
      form.mode === "dynamic" ? null : form.destinationHost.trim(),
    destinationPort: form.mode === "dynamic" ? null : form.destinationPort,
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
let statusListener: Promise<void> | null = null;
const loadSequenceByHost = new Map<string, number>();

function ensureStatusListener() {
  if (statusListener) return statusListener;
  statusListener = listen<ForwardStatusEvent>("forward-status", (event) => {
    const { id, status } = event.payload;
    usePortForwardingStore.setState((state) => ({
      forwards: state.forwards.map((forward) =>
        forward.id === id ? { ...forward, status } : forward,
      ),
    }));
  })
    .then(() => undefined)
    .catch((error) => {
      statusListener = null;
      throw error;
    });
  return statusListener;
}

function signalDefinitionMutation(hostId: string): void {
  if (typeof window === "undefined") return;
  const vaultId = useHostStore
    .getState()
    .hosts.find((host) => host.id === hostId)?.vaultId;
  window.dispatchEvent(
    new CustomEvent("terra:local-mutation", {
      detail: { table: "port_forwards", ...(vaultId ? { vaultId } : {}) },
    }),
  );
}

function replaceForward(forwards: PortForward[], next: PortForward) {
  const index = forwards.findIndex((forward) => forward.id === next.id);
  if (index === -1) return [...forwards, next];
  return forwards.map((forward) => (forward.id === next.id ? next : forward));
}

export const usePortForwardingStore = create<PortForwardingState>(
  (set, get) => ({
    hostId: null,
    forwards: [],
    isLoading: false,
    error: null,
    busyIds: [],

    loadForwards: async (hostId) => {
      const sequence = (loadSequenceByHost.get(hostId) ?? 0) + 1;
      loadSequenceByHost.set(hostId, sequence);
      set({ hostId, isLoading: true, error: null });
      try {
        await ensureStatusListener();
        const views = await invoke<ForwardView[]>("list_port_forwards", {
          deviceId: await getDeviceId(),
          hostId,
        });
        if (sequence === loadSequenceByHost.get(hostId)) {
          set((state) => ({
            forwards: [
              ...state.forwards.filter((forward) => forward.hostId !== hostId),
              ...views.map(toForward),
            ],
            isLoading: false,
          }));
        }
      } catch (error) {
        if (sequence === loadSequenceByHost.get(hostId))
          set({ error: errorText(error), isLoading: false });
        throw error;
      }
    },

    createForward: async (input) => {
      try {
        const forward = toForward(
          await invoke<ForwardView>("create_port_forward", {
            input,
            deviceId: await getDeviceId(),
          }),
        );
        set((state) => ({
          forwards: replaceForward(state.forwards, forward),
          error: null,
        }));
        signalDefinitionMutation(forward.hostId);
        return forward;
      } catch (error) {
        set({ error: errorText(error) });
        throw error;
      }
    },

    updateForward: async (id, input) => {
      set((state) => ({ busyIds: [...state.busyIds, id] }));
      try {
        const forward = toForward(
          await invoke<ForwardView>("update_port_forward", {
            id,
            input,
            deviceId: await getDeviceId(),
          }),
        );
        set((state) => ({
          forwards: replaceForward(state.forwards, forward),
          error: null,
        }));
        signalDefinitionMutation(forward.hostId);
        return forward;
      } catch (error) {
        set({ error: errorText(error) });
        throw error;
      } finally {
        set((state) => ({
          busyIds: state.busyIds.filter((busyId) => busyId !== id),
        }));
      }
    },

    deleteForward: async (id) => {
      set((state) => ({ busyIds: [...state.busyIds, id] }));
      try {
        const hostId =
          get().forwards.find((forward) => forward.id === id)?.hostId ??
          get().hostId ??
          "";
        await invoke("delete_port_forward", {
          id,
          deviceId: await getDeviceId(),
        });
        signalDefinitionMutation(hostId);
        set((state) => ({
          forwards: state.forwards.filter((forward) => forward.id !== id),
          error: null,
        }));
      } catch (error) {
        set({ error: errorText(error) });
        throw error;
      } finally {
        set((state) => ({
          busyIds: state.busyIds.filter((busyId) => busyId !== id),
        }));
      }
    },

    startForward: async (id, ownerPaneId) => {
      set((state) => ({ busyIds: [...state.busyIds, id] }));
      try {
        const forward = toForward(
          await invoke<ForwardView>("start_port_forward", {
            id,
            ownerPaneId,
            deviceId: await getDeviceId(),
          }),
        );
        set((state) => ({
          forwards: replaceForward(state.forwards, forward),
          error: null,
        }));
        return forward;
      } catch (error) {
        const message = errorText(error);
        set((state) => ({
          forwards: state.forwards.map((forward) =>
            forward.id === id
              ? { ...forward, status: { state: "failed", error: message } }
              : forward,
          ),
          error: message,
        }));
        throw error;
      } finally {
        set((state) => ({
          busyIds: state.busyIds.filter((busyId) => busyId !== id),
        }));
      }
    },

    stopForward: async (id) => {
      set((state) => ({ busyIds: [...state.busyIds, id] }));
      try {
        const forward = toForward(
          await invoke<ForwardView>("stop_port_forward", {
            id,
            deviceId: await getDeviceId(),
          }),
        );
        set((state) => ({
          forwards: replaceForward(state.forwards, forward),
          error: null,
        }));
        return forward;
      } catch (error) {
        set({ error: errorText(error) });
        throw error;
      } finally {
        set((state) => ({
          busyIds: state.busyIds.filter((busyId) => busyId !== id),
        }));
      }
    },

    clearError: () => set({ error: null }),
  }),
);
