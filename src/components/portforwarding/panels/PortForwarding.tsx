import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ForwardCard } from "@/components/portforwarding/cards/ForwardCard";
import PortForwardForm from "@/components/portforwarding/forms/PortForwardForm";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import Spinner from "@/components/ui/Spinner";
import type { PortForwardFormSchema } from "@/lib/schema/portforwarding/portForwardFormSchema";
import {
  type PortForward,
  toForwardInput,
  usePortForwardingStore,
} from "@/stores/portforwarding/portForwardingStore";

interface PortForwardingProps {
  hostId?: string;
  paneId?: string;
}

export default function PortForwarding({
  hostId,
  paneId,
}: PortForwardingProps) {
  const {
    forwards,
    isLoading,
    error,
    busyIds,
    loadForwards,
    createForward,
    updateForward,
    deleteForward,
    startForward,
    stopForward,
  } = usePortForwardingStore();
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PortForward | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (hostId) void loadForwards(hostId).catch(() => undefined);
  }, [hostId, loadForwards]);

  const submit = async (data: PortForwardFormSchema) => {
    if (!hostId) throw new Error("Select a saved SSH host first");
    const input = toForwardInput(hostId, data);
    if (editTarget) {
      await updateForward(editTarget.id, input);
      toast.success("Port forward saved");
    } else {
      await createForward(input);
      toast.success("Port forward saved. Press Start to connect.");
    }
    setEditTarget(null);
  };

  const handleStart = async (id: string) => {
    if (!paneId) {
      toast.error("Open this saved SSH host in a terminal pane first");
      return;
    }
    try {
      await startForward(id, paneId);
      toast.success("Port forward started");
    } catch {
      // The store keeps the error on the affected card.
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopForward(id);
      toast.success("Port forward stopped");
    } catch {
      // The store displays the IPC error.
    }
  };

  const handleDelete = async () => {
    const id = deleteTargetId;
    if (!id) return;
    try {
      await deleteForward(id);
      setDeleteTargetId(null);
      toast.success("Port forward deleted");
    } catch {
      // Keep the confirmation visible so the user can retry.
    }
  };

  const hostForwards = forwards.filter((forward) => forward.hostId === hostId);

  if (!hostId) {
    return (
      <div className="p-4 text-sm text-dark-400">
        Select a saved SSH host to manage port forwards.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-dark-700 p-4">
        <SectionHeader title="Port Forwarding" className="text-lg">
          <Button
            type="button"
            onClick={() => {
              setEditTarget(null);
              setFormOpen(true);
            }}
            size="sm"
          >
            + Add Forward
          </Button>
        </SectionHeader>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-lg bg-danger-500/10 p-2 text-xs text-danger-400"
          >
            {error}
          </p>
        )}
        {isLoading ? (
          <div className="py-8 text-center text-dark-400">
            <Spinner className="mx-auto mb-4" />
            <p>Loading port forwards...</p>
          </div>
        ) : hostForwards.length === 0 ? (
          <EmptyState
            icon={ArrowsLeftRightIcon}
            title="No port forwards configured"
            description="Save a local, remote, or SOCKS5 forward, then start it when needed."
          />
        ) : (
          <div className="space-y-3">
            {hostForwards.map((forward) => (
              <ForwardCard
                key={forward.id}
                forward={forward}
                busy={busyIds.includes(forward.id)}
                onStart={handleStart}
                onStop={handleStop}
                onEdit={() => {
                  setEditTarget(forward);
                  setFormOpen(true);
                }}
                onDelete={setDeleteTargetId}
              />
            ))}
          </div>
        )}
      </div>
      {formOpen && (
        <PortForwardForm
          initial={editTarget ?? undefined}
          onClose={() => {
            setFormOpen(false);
            setEditTarget(null);
          }}
          onSubmit={submit}
        />
      )}
      <ConfirmDeleteDialog
        open={deleteTargetId !== null}
        message="Delete this saved port forward? A running forward will stop."
        onConfirm={handleDelete}
        onCancel={() => setDeleteTargetId(null)}
      />
    </div>
  );
}
