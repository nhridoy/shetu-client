import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  AGENT_FORWARD_HELP,
  answerAgentForwarding,
  useAgentForwardAsks,
} from "@/lib/terminal/agentForwarding";

/** Asks once per device before a host's synced "Forward SSH agent" flag takes effect. */
export default function AgentForwardDialog() {
  const ask = useAgentForwardAsks((s) => s.queue[0]);
  if (!ask) return null;
  return (
    <ConfirmDialog
      open
      title={`Forward your SSH agent to ${ask.host}?`}
      message={AGENT_FORWARD_HELP}
      confirmLabel="Allow"
      cancelLabel="Don't allow"
      onConfirm={() => answerAgentForwarding(true)}
      onCancel={() => answerAgentForwarding(false)}
    />
  );
}
