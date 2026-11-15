import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getRow } from "@/lib/db/db";
import { fetchInheritedDefaults } from "@/lib/hosts/inherited";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import {
  askUsername,
  registerSavedHostSession,
  rememberCredentials,
  stopSavingCredentials,
} from "./pendingCredentials";

export const AGENT_FORWARD_HELP =
  "Lets this server use your local SSH keys while you're connected. Anyone with root on the server can use them too. Only enable for servers you trust.";

interface Ask {
  host: string;
  resolve: (allowed: boolean) => void;
}

/** Pending "Forward your SSH agent?" questions, shown one at a time by AgentForwardDialog. */
export const useAgentForwardAsks = create<{ queue: Ask[] }>(() => ({
  queue: [],
}));

export function answerAgentForwarding(allowed: boolean) {
  const [ask, ...rest] = useAgentForwardAsks.getState().queue;
  useAgentForwardAsks.setState({ queue: rest });
  ask?.resolve(allowed);
}

/** Records (or with `null`, forgets) this device's agent-forwarding answer for a host. */
export async function recordAgentForwarding(
  hostId: string,
  allowed: boolean | null,
) {
  await useSettingsStore.getState().whenLoaded();
  const { settings, updateSetting } = useSettingsStore.getState();
  const { [hostId]: _old, ...rest } = settings.agentForwardingDecisions;
  return updateSetting(
    "agentForwardingDecisions",
    allowed === null ? rest : { ...rest, [hostId]: allowed },
  );
}

/** The host's own On/Off wins; "From group" (null) takes the group chain's value. */
export async function effectiveForwardAgent(host: {
  forwardAgent?: boolean | null;
  groupId?: string | null;
  vaultId?: string;
}): Promise<boolean> {
  if (host.forwardAgent != null) return host.forwardAgent;
  if (!host.groupId || !host.vaultId) return false;
  try {
    const d = await fetchInheritedDefaults(host.groupId, host.vaultId);
    return d.forwardAgent ?? false;
  } catch {
    return false; // fail closed; Rust still gates the connect
  }
}

// Panes opening together for one host share a single question.
const asking = new Map<string, Promise<boolean>>();

async function askAndRecord(hostId: string): Promise<boolean> {
  const host = await useHostStore.getState().getDecryptedHost(hostId);
  if (!host || !(await effectiveForwardAgent(host))) return false;
  const allowed = await new Promise<boolean>((resolve) =>
    useAgentForwardAsks.setState((s) => ({
      queue: [...s.queue, { host: host.name || host.address, resolve }],
    })),
  );
  await recordAgentForwarding(hostId, allowed);
  return allowed;
}

/** The synced host flag alone never forwards the agent: this device must have said yes. */
async function agentForwardingAllowed(hostId: string): Promise<boolean> {
  await useSettingsStore.getState().whenLoaded();
  const recorded =
    useSettingsStore.getState().settings.agentForwardingDecisions[hostId];
  if (typeof recorded === "boolean") return recorded;
  let pending = asking.get(hostId);
  if (!pending) {
    pending = askAndRecord(hostId).finally(() => asking.delete(hostId));
    asking.set(hostId, pending);
  }
  return pending;
}

/** The user cancelled a question the connect needed; retrying would only ask again. */
export class ConnectCancelled extends Error {}

/** Opens a terminal to a saved host; every terminal connect and reconnect goes through here.
 * `isCancelled` is checked after the consent question, so a closed pane opens no session. */
export async function connectSavedTerminal(
  args: {
    sessionId: string;
    hostId: string;
    detectOs: boolean;
    cols: number;
    rows: number;
  },
  isCancelled: () => boolean = () => false,
) {
  registerSavedHostSession(args.sessionId, args.hostId);
  const username = await missingUsername(
    args.sessionId,
    args.hostId,
    true,
    isCancelled,
  );
  if (isCancelled()) return;
  if (username === null)
    throw new ConnectCancelled("Connection cancelled: no username.");
  const allowAgentForwarding = await agentForwardingAllowed(args.hostId);
  if (isCancelled()) return;
  await invoke("connect_saved", { ...args, username, allowAgentForwarding });
}

/** For SFTP and editor connects to a saved host: the typed username, or `undefined` when
 * nothing is missing. Saving is not offered: these connects have no "connected" hook. */
export async function resolveUsernameOrAsk(sessionId: string, hostId: string) {
  const username = await missingUsername(sessionId, hostId, false);
  if (username === null)
    throw new ConnectCancelled("Connection cancelled: no username.");
  return username;
}

/** Asks when neither the host nor its groups name a user: the answer, `undefined` when
 * nothing is missing, or `null` when the user cancelled. */
async function missingUsername(
  sessionId: string,
  hostId: string,
  canSave = true,
  isCancelled: () => boolean = () => false,
) {
  const host = await useHostStore.getState().getDecryptedHost(hostId);
  if (!host) return undefined;
  const ownName = !!host.username?.trim();
  // Without a vaultId, or when the group lookup fails, we ask even if a group sets one,
  // but never offer Save: a saved name would override the group's.
  const inherited =
    host.groupId && host.vaultId && (!ownName || host.authType === "inherit")
      ? await fetchInheritedDefaults(host.groupId, host.vaultId).catch(
          () => null,
        )
      : undefined;
  const ownIdentity = host.authType === "identity";
  if (
    ownIdentity ||
    (host.authType === "inherit" && inherited?.authType === "identity")
  )
    stopSavingCredentials(sessionId);
  // A usable identity supplies the username; a deleted one leaves the host on its own.
  if (ownIdentity && (await identityUsable(host.identityId, host.vaultId)))
    return undefined;
  // A group identity's username only applies to hosts that inherit the login.
  const groupName =
    host.authType === "inherit" || inherited?.authType !== "identity"
      ? inherited?.username
      : inherited?.groupUsername;
  if (ownName || groupName) return undefined;
  const groupKnown = !host.groupId || !!inherited;
  // A closed pane gets no question; its caller checks isCancelled and stops.
  if (isCancelled()) return undefined;
  const answer = await askUsername(
    sessionId,
    host.name || host.address,
    canSave && groupKnown && !ownIdentity,
  );
  if (!answer) return null;
  if (answer.save)
    rememberCredentials(sessionId, { username: answer.username });
  return answer.username;
}

async function identityUsable(id?: string | null, vaultId?: string) {
  if (!id) return false;
  const row = await getRow("identities", id).catch(() => null);
  return !!row && !row.deleted_at && row.vault_id === vaultId;
}
