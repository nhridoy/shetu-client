import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import { useAuthStore } from "@/stores/auth/authStore";
import { useTeamStore } from "@/stores/teams/teamStore";

export default function DeleteAccountDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { user, requestAccountDeletion } = useAuthStore();
  const { teams } = useTeamStore();
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountEmail = user?.email ?? "";
  const ownedTeams = teams.filter((t) => t.ownerId === user?.id);
  const canConfirm =
    !busy &&
    password !== "" &&
    email.trim().toLowerCase() === accountEmail.trim().toLowerCase();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // On success the app resets and lands on sign-in, unmounting this dialog.
      await requestAccountDeletion(password, accountEmail);
    } catch (err) {
      setError(extractError(err, "Failed to delete account"));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Delete your account?" hideClose={busy}>
      <div className="space-y-4">
        <div className="space-y-1 text-sm text-dark-300">
          <p>
            Your vault, hosts, keys, snippets, port forwards and session history
            will be deleted.
          </p>
          {ownedTeams.map((t) => (
            <p key={t.id}>
              {t.name}
              {t.members && ` (${t.members.length} members)`} — deleted for
              everyone
            </p>
          ))}
          <p>
            You have 30 days to change your mind — sign in again and choose
            “Keep my account” to cancel.
          </p>
          <p>
            Changes on your other devices that haven't synced yet will be lost.
          </p>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        <Input
          type="password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <Input
          type="text"
          aria-label="Type your email to confirm"
          placeholder="Type your email to confirm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={submit}
            disabled={!canConfirm}
          >
            Delete my account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
