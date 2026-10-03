import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

export const RELEASE_URL = "https://github.com/nhridoy/terra/releases/latest";

export type InstallationKind =
  | "development"
  | "appimage"
  | "package"
  | "native";
export type UpdateHandle = Update;

export const updateService = {
  installationKind: () => invoke<InstallationKind>("update_installation_kind"),
  check: () => check({ timeout: 15_000 }),
  download: (update: UpdateHandle, onEvent: (event: DownloadEvent) => void) =>
    update.download(onEvent),
  install: (update: UpdateHandle) => update.install(),
  relaunch: () => relaunch(),
  close: (update: UpdateHandle) => update.close(),
  openReleasePage: () => openUrl(RELEASE_URL),
};
