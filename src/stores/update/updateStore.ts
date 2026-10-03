import { create } from "zustand";
import {
  type InstallationKind,
  RELEASE_URL,
  type UpdateHandle,
  updateService,
} from "@/lib/update/updateService";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "restart_required"
  | "error"
  | "development";

interface UpdateState {
  status: UpdateStatus;
  installationKind: InstallationKind | null;
  updateInfo: { version: string; notes: string; date: string | null } | null;
  downloadProgress: number | null;
  error: string | null;
  promptDismissed: boolean;
  releaseUrl: string;
  checkForUpdates: (manual?: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  restartApp: () => Promise<void>;
  openReleasePage: () => Promise<void>;
  dismissUpdate: () => void;
}

let pendingUpdate: UpdateHandle | null = null;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  installationKind: null,
  updateInfo: null,
  downloadProgress: null,
  error: null,
  promptDismissed: false,
  releaseUrl: RELEASE_URL,

  checkForUpdates: async (manual = false) => {
    if (["available", "ready", "restart_required"].includes(get().status)) {
      if (manual) set({ promptDismissed: false });
      return;
    }
    if (["checking", "downloading", "installing"].includes(get().status))
      return;
    set({ status: "checking", error: null });
    try {
      const installationKind = await updateService.installationKind();
      if (installationKind === "development") {
        set({
          installationKind,
          status: manual ? "development" : "idle",
          updateInfo: null,
        });
        return;
      }
      const update = await updateService.check();
      if (pendingUpdate) await updateService.close(pendingUpdate);
      pendingUpdate = update;
      set({
        installationKind,
        status: update ? "available" : manual ? "current" : "idle",
        updateInfo: update
          ? {
              version: update.version,
              notes: update.body ?? "",
              date: update.date ?? null,
            }
          : null,
        downloadProgress: null,
        promptDismissed: false,
      });
    } catch (error) {
      set({
        status: manual ? "error" : "idle",
        error: manual ? message(error) : null,
      });
    }
  },

  downloadUpdate: async () => {
    if (get().status !== "available") return;
    if (get().installationKind === "package") {
      await get().openReleasePage();
      return;
    }
    if (!pendingUpdate) return;
    set({ status: "downloading", error: null, downloadProgress: null });
    let downloaded = 0;
    let total: number | undefined;
    try {
      await updateService.download(pendingUpdate, (event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event === "Finished") set({ downloadProgress: 100 });
        else if (total && total > 0)
          set({
            downloadProgress: Math.min(
              99,
              Math.floor((downloaded / total) * 100),
            ),
          });
      });
      set({ status: "ready", downloadProgress: 100 });
    } catch (error) {
      set({
        status: "available",
        error: message(error),
        downloadProgress: null,
      });
    }
  },

  installUpdate: async () => {
    if (get().status !== "ready" || !pendingUpdate) return;
    set({ status: "installing", error: null });
    try {
      await updateService.install(pendingUpdate);
      set({ status: "restart_required" });
    } catch (error) {
      set({ status: "ready", error: message(error) });
      return;
    }
    await get().restartApp();
  },

  restartApp: async () => {
    if (get().status !== "restart_required") return;
    set({ error: null });
    try {
      await updateService.relaunch();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  openReleasePage: async () => {
    try {
      await updateService.openReleasePage();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  dismissUpdate: () => {
    if (!["downloading", "installing"].includes(get().status))
      set({ promptDismissed: true });
  },
}));
