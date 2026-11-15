import { invoke } from "@tauri-apps/api/core";

let unlockStarted = false;

/** Starts forwards set to "When Shetu unlocks", once per app run. Best-effort. */
export async function autoStartOnUnlock(): Promise<void> {
  if (unlockStarted) return;
  unlockStarted = true;
  await invoke("auto_start_forwards", { trigger: "unlock" }).catch(() => {});
}

/** Starts a host's "With a terminal" forwards for this pane; already-running ones are skipped. */
export async function autoStartWithTerminal(
  hostId: string,
  ownerPaneId: string,
): Promise<void> {
  await invoke("auto_start_forwards", {
    trigger: "terminal",
    hostId,
    ownerPaneId,
  }).catch(() => {});
}

export function resetAutoStartForTests() {
  unlockStarted = false;
}
