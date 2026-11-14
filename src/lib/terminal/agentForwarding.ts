import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";

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
export function recordAgentForwarding(hostId: string, allowed: boolean | null) {
  const { settings, updateSetting } = useSettingsStore.getState();
  const { [hostId]: _old, ...rest } = settings.agentForwardingDecisions;
  return updateSetting(
    "agentForwardingDecisions",
    allowed === null ? rest : { ...rest, [hostId]: allowed },
  );
}

// Panes opening together for one host share a single question.
const asking = new Map<string, Promise<boolean>>();

async function askAndRecord(hostId: string): Promise<boolean> {
  const host = await useHostStore.getState().getDecryptedHost(hostId);
  if (!host?.forwardAgent) return false;
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
  const allowAgentForwarding = await agentForwardingAllowed(args.hostId);
  if (isCancelled()) return;
  await invoke("connect_saved", { ...args, allowAgentForwarding });
}
