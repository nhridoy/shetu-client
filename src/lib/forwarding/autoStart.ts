import { invoke } from "@tauri-apps/api/core";

let unlockStartedFor: string | null = null;

/** Starts forwards set to "When Shetu unlocks", once per account per run. Best-effort. */
export async function autoStartOnUnlock(accountId: string): Promise<void> {
  if (unlockStartedFor === accountId) return;
  unlockStartedFor = accountId;
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
  unlockStartedFor = null;
}
