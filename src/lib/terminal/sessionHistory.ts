import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "@/stores/sessions/sessionStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

type ConnectionType = "ssh" | "local";
type Attempt = {
  vaultId: string;
  paneId?: string;
  recording: boolean;
  flushTimer: ReturnType<typeof setInterval> | null;
  pending: Promise<void>;
  closing: boolean;
};
const active = new Map<string, Attempt>();

export function isPaneRecording(paneId: string): boolean {
  return [...active.values()].some(
    (attempt) =>
      attempt.paneId === paneId && attempt.recording && !attempt.closing,
  );
}

function notifyRecordingChange() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("termvault:recording-change"));
}

function reportHistoryError(error: unknown) {
  useSessionStore.setState({ error: `Session history: ${String(error)}` });
}

function notifyMutation(vaultId: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("termvault:local-mutation", { detail: { vaultId } }),
    );
  }
}

function enqueue(
  attempt: Attempt,
  action: () => Promise<unknown>,
  notify: boolean | "ifTrue" = true,
): Promise<void> {
  const next = attempt.pending
    .then(action)
    .then((result) => {
      if (notify === true || (notify === "ifTrue" && result === true))
        notifyMutation(attempt.vaultId);
    })
    .catch(reportHistoryError);
  attempt.pending = next;
  return next;
}

export async function beginHistoryAttempt(
  hostId: string,
  hostLabel: string,
  connectionType: ConnectionType,
  paneId?: string,
): Promise<string | null> {
  const vault = useVaultStore
    .getState()
    .vaults.find((item) => item.isDefault && !item.isShared);
  if (!vault) {
    reportHistoryError("default personal vault unavailable");
    return null;
  }
  const attemptId = crypto.randomUUID();
  const recording = useSettingsStore.getState().settings.recordTerminalOutput;
  try {
    await invoke("history_start_attempt", {
      vaultId: vault.id,
      paneId,
      attemptId,
      hostId,
      hostLabel,
      connectionType,
      recording,
    });
    const attempt: Attempt = {
      vaultId: vault.id,
      recording,
      flushTimer: null,
      pending: Promise.resolve(),
      closing: false,
    };
    attempt.flushTimer = recording
      ? setInterval(() => {
          if (!attempt.closing)
            void enqueue(
              attempt,
              () => invoke("history_flush_output", { attemptId }),
              "ifTrue",
            );
        }, 1000)
      : null;
    active.set(attemptId, attempt);
    notifyRecordingChange();
    notifyMutation(vault.id);
    return attemptId;
  } catch (error) {
    reportHistoryError(error);
    return null;
  }
}

export async function markHistoryConnected(
  attemptId: string | null,
): Promise<void> {
  const attempt = attemptId ? active.get(attemptId) : null;
  if (!attempt || attempt.closing) return;
  await enqueue(attempt, () => invoke("history_mark_connected", { attemptId }));
}

export async function captureHistoryOutput(
  attemptId: string | null,
  output: string,
): Promise<void> {
  const attempt = attemptId ? active.get(attemptId) : null;
  if (!attempt?.recording || attempt.closing) return;
  await enqueue(attempt, () =>
    invoke("history_append_output", { attemptId, output }),
  );
}

export async function finishHistoryAttempt(
  attemptId: string | null,
  outcome: "ended" | "failed" | "interrupted",
  reason: string,
): Promise<void> {
  if (!attemptId) return;
  const attempt = active.get(attemptId);
  if (!attempt || attempt.closing) return;
  attempt.closing = true;
  notifyRecordingChange();
  if (attempt.flushTimer) clearInterval(attempt.flushTimer);
  await attempt.pending;
  try {
    await invoke("history_finish_attempt", { attemptId, outcome, reason });
    notifyMutation(attempt.vaultId);
  } catch (error) {
    reportHistoryError(error);
  } finally {
    active.delete(attemptId);
    notifyRecordingChange();
  }
}
