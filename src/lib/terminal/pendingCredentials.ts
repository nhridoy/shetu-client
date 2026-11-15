import { toast } from "sonner";
import { create } from "zustand";
import type { Host } from "@/stores/hosts/hostStore";
import { useHostStore } from "@/stores/hosts/hostStore";

/** Credentials typed at connect time, held in memory until the session connects. */
type Credentials = { username?: string; password?: string };

// Terminal sessions opened to a saved host: sessionId → hostId.
const savedHostSessions = new Map<string, string>();
const pending = new Map<string, Credentials>();

/** Marks a new saved-host connect attempt; anything left from an earlier attempt is dropped. */
export function registerSavedHostSession(sessionId: string, hostId: string) {
  savedHostSessions.set(sessionId, hostId);
  pending.delete(sessionId);
}

/** Identity hosts never save typed credentials: they would be ignored or replace the identity. */
export function stopSavingCredentials(sessionId: string) {
  savedHostSessions.delete(sessionId);
  pending.delete(sessionId);
}

export function isSavedHostSession(sessionId: string) {
  return savedHostSessions.has(sessionId);
}

export function rememberCredentials(sessionId: string, creds: Credentials) {
  if (!savedHostSessions.has(sessionId)) return;
  pending.set(sessionId, { ...pending.get(sessionId), ...creds });
}

export function dropPendingCredentials(sessionId: string) {
  pending.delete(sessionId);
}

/** The pane closed: forget the session entirely, including a username question still open. */
export function forgetSession(sessionId: string) {
  pending.delete(sessionId);
  savedHostSessions.delete(sessionId);
  const { queue } = useUsernameAsks.getState();
  useUsernameAsks.setState({
    queue: queue.filter((a) => a.sessionId !== sessionId),
  });
  for (const a of queue) if (a.sessionId === sessionId) a.resolve(null);
}

/** Called once the session reaches "connected"; the typed values are dropped either way. */
export async function savePendingCredentials(sessionId: string) {
  const creds = pending.get(sessionId);
  const hostId = savedHostSessions.get(sessionId);
  pending.delete(sessionId);
  if (!creds || !hostId) return;
  const patch: Partial<Host> = {};
  if (creds.username !== undefined) patch.username = creds.username;
  if (creds.password !== undefined) patch.password = creds.password;
  if (Object.keys(patch).length === 0) return;
  // The store derives authType from the row inside the queued save (key → both, else password).
  const saved = await useHostStore
    .getState()
    .updateHost(hostId, patch, { passwordAuth: creds.password !== undefined })
    .catch(() => false);
  if (!saved) toast.error("Couldn't save credentials to this host");
}

interface UsernameAsk {
  id: number;
  sessionId: string;
  host: string;
  /** False hides "Save to this host". */
  canSave: boolean;
  resolve: (answer: { username: string; save: boolean } | null) => void;
}

/** Pending "Username for …" questions, shown one at a time by UsernamePromptDialog. */
export const useUsernameAsks = create<{ queue: UsernameAsk[] }>(() => ({
  queue: [],
}));

let nextAskId = 0;

export function askUsername(sessionId: string, host: string, canSave = true) {
  return new Promise<{ username: string; save: boolean } | null>((resolve) =>
    useUsernameAsks.setState((s) => ({
      queue: [
        ...s.queue,
        { id: ++nextAskId, sessionId, host, canSave, resolve },
      ],
    })),
  );
}

export function answerUsername(
  answer: { username: string; save: boolean } | null,
) {
  const [ask, ...rest] = useUsernameAsks.getState().queue;
  useUsernameAsks.setState({ queue: rest });
  ask?.resolve(answer);
}
