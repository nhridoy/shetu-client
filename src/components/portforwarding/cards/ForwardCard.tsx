import { Button } from "@/components/ui/Button";
import type { PortForward } from "@/stores/portforwarding/portForwardingStore";

interface ForwardCardProps {
  forward: PortForward;
  busy: boolean;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

function endpoint(forward: PortForward) {
  if (forward.mode === "remote")
    return `${forward.remoteBindAddress}:${forward.remotePort}`;
  return `127.0.0.1:${forward.localPort}`;
}

const modeNames = {
  local: "Local TCP",
  remote: "Remote TCP",
  dynamic: "Dynamic SOCKS5",
};

export function ForwardCard({
  forward,
  busy,
  onStart,
  onStop,
  onEdit,
  onDelete,
}: ForwardCardProps) {
  const active = forward.status.state === "active";
  const starting = forward.status.state === "starting";
  return (
    <article className="rounded-lg border border-dark-700 bg-dark-800 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-white">
            {forward.name}
          </h3>
          <p className="text-xs text-dark-400">{modeNames[forward.mode]}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${active ? "bg-green-500/15 text-green-400" : starting ? "bg-primary-500/15 text-primary-400" : forward.status.state === "failed" ? "bg-danger-500/15 text-danger-400" : "bg-dark-700 text-dark-300"}`}
        >
          {forward.status.state}
        </span>
      </div>
      <p className="break-all text-xs text-dark-300">
        {endpoint(forward)}
        {forward.mode !== "dynamic" &&
          ` → ${forward.destinationHost}:${forward.destinationPort}`}
      </p>
      {forward.status.error && (
        <p role="alert" className="text-xs text-danger-400">
          {forward.status.error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {active || starting ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onStop(forward.id)}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onStart(forward.id)}
          >
            Start
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || active || starting}
          onClick={() => onEdit(forward.id)}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onDelete(forward.id)}
        >
          Delete
        </Button>
      </div>
    </article>
  );
}
