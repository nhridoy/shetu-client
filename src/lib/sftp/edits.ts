import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settings/settingsStore";

/** Mirror of `src-tauri/src/edits/state.rs`. */
export type EditStatus = "watching" | "uploading" | "conflict" | "notUploaded";
export type EditChoice = "overwrite" | "keepServer" | "saveAsCopy";

export interface RemoteEdit {
  id: string;
  sessionId: string;
  host: { hostId: string | null; host: string; port: number; username: string };
  remotePath: string;
  localPath: string;
  baseline: [number, number];
  lastLocal: [number, number];
  unsent: boolean;
  status: EditStatus;
  job: string | null;
  uploading: [number, number] | null;
  dirty: boolean;
  savingCopy: boolean;
  conflict: [number, number] | null;
  error: string | null;
}

export interface EditConflict {
  id: string;
  fileName: string;
  host: string;
  remotePath: string;
}

export const listEdits = () => invoke<RemoteEdit[]>("edit_list");
export const stopEdit = (id: string, discard: boolean) =>
  invoke<void>("edit_stop", { id, discard });
export const resolveEdit = (id: string, choice: EditChoice) =>
  invoke<void>("edit_resolve", { id, choice });
export const uploadEditNow = (id: string) =>
  invoke<void>("edit_upload_now", { id });
export const onEditsChanged = (
  cb: (edits: RemoteEdit[]) => void,
): Promise<UnlistenFn> =>
  listen<RemoteEdit[]>("edits://changed", (e) => cb(e.payload));
export const onEditConflict = (
  cb: (conflict: EditConflict) => void,
): Promise<UnlistenFn> =>
  listen<EditConflict>("edits://conflict", (e) => cb(e.payload));

export function fileNameOf(path: string): string {
  return path.split("/").pop() || path;
}

function extensionOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Asks which app to use, starting at the one chosen for this file type before, and
 * remembers the answer. Undefined when the user cancels. */
async function appFor(path: string): Promise<string | undefined> {
  const ext = extensionOf(path);
  const store = useSettingsStore.getState();
  const remembered = store.settings.openWithApps[ext];
  const picked = await open({
    title: "Choose an app",
    multiple: false,
    directory: false,
    defaultPath: remembered,
  });
  if (!picked || Array.isArray(picked)) return undefined;
  await store.updateSetting("openWithApps", {
    ...store.settings.openWithApps,
    [ext]: picked,
  });
  return picked;
}

/** Opens a remote file in a desktop app; each save uploads back. Null when the user backs out. */
export async function openRemoteFile(
  sessionId: string,
  path: string,
  opts: { withApp?: boolean } = {},
): Promise<RemoteEdit | null> {
  let appName: string | null = null;
  if (opts.withApp) {
    const app = await appFor(path);
    if (app === undefined) return null;
    appName = app;
  }
  const call = (confirmLarge: boolean) =>
    invoke<RemoteEdit>("edit_open", {
      sessionId,
      remotePath: path,
      appName,
      confirmLarge,
    });
  try {
    return await call(false);
  } catch (e) {
    const large = /^large:(\d+)$/.exec(String(e));
    if (!large) throw e;
    const mb = (Number(large[1]) / (1024 * 1024)).toFixed(1);
    const ok = await confirm(
      `${fileNameOf(path)} is ${mb} MB. Download and open it?`,
      {
        title: "Large file",
        kind: "warning",
      },
    );
    return ok ? call(true) : null;
  }
}

/** Pane disconnect: stops that pane's edits. Ones with unsent work refuse ("unsent") and stay,
 * so their changes can still be uploaded. */
export async function stopEditsForSession(
  sessionId: string,
  edits: RemoteEdit[],
): Promise<void> {
  for (const edit of edits.filter((e) => e.sessionId === sessionId)) {
    await stopEdit(edit.id, false).catch(() => {});
  }
}
