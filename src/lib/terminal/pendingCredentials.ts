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
  const { hosts, updateHost } = useHostStore.getState();
  const patch: Partial<Host> = {};
  if (creds.username !== undefined) patch.username = creds.username;
  if (creds.password !== undefined) {
    const own = hosts.find((h) => h.id === hostId)?.authType;
    patch.password = creds.password;
    // A key the host already uses stays in play next to the saved password.
    patch.authType = own === "key" || own === "both" ? "both" : "password";
  }
  if (Object.keys(patch).length === 0) return;
  const saved = await updateHost(hostId, patch).catch(() => false);
  if (!saved) toast.error("Couldn't save credentials to this host");
}

interface UsernameAsk {
  id: number;
  sessionId: string;
  host: string;
  resolve: (answer: { username: string; save: boolean } | null) => void;
}

/** Pending "Username for …" questions, shown one at a time by UsernamePromptDialog. */
export const useUsernameAsks = create<{ queue: UsernameAsk[] }>(() => ({
  queue: [],
}));

let nextAskId = 0;

export function askUsername(sessionId: string, host: string) {
  return new Promise<{ username: string; save: boolean } | null>((resolve) =>
    useUsernameAsks.setState((s) => ({
      queue: [...s.queue, { id: ++nextAskId, sessionId, host, resolve }],
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
