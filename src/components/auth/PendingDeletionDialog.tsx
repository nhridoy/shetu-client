import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useAuthStore } from "@/stores/auth/authStore";

export default function PendingDeletionDialog() {
  const { pendingDeletion, cancelAccountDeletion, logout } = useAuthStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pendingDeletion) return null;

  const d = new Date(pendingDeletion);
  const when = Number.isNaN(d.getTime())
    ? ""
    : ` on ${d.toLocaleDateString(undefined, { dateStyle: "long" })}`;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={() => {}}
      title="Account scheduled for deletion"
      hideClose
      zClass="z-[60]"
    >
      <p className="text-sm text-dark-200">
        Your account is scheduled for deletion{when}.
      </p>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => run(logout)}
        >
          Sign out
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(cancelAccountDeletion)}
        >
          Keep my account
        </Button>
      </div>
    </Modal>
  );
}
