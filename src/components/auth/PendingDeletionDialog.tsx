import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useAuthStore } from "@/stores/auth/authStore";

export default function PendingDeletionDialog() {
  const { pendingDeletion, cancelAccountDeletion, logout } = useAuthStore();
  if (!pendingDeletion) return null;
  // Remount per sign-in so an earlier error never shows on the next one.
  return (
    <Choice
      key={pendingDeletion}
      pendingDeletion={pendingDeletion}
      cancelAccountDeletion={cancelAccountDeletion}
      logout={logout}
    />
  );
}

function Choice({
  pendingDeletion,
  cancelAccountDeletion,
  logout,
}: {
  pendingDeletion: string;
  cancelAccountDeletion: () => Promise<void>;
  logout: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      zClass="z-[55]"
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
