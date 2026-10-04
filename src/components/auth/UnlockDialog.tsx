import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useAuthStore } from "@/stores/auth/authStore";

export default function UnlockDialog() {
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUnlocked = useAuthStore((s) => s.isUnlocked);
  const localAccessAccountId = useAuthStore((s) => s.localAccessAccountId);
  const unlockPending = useAuthStore((s) => s.unlockPending);
  const unlock = useAuthStore((s) => s.unlock);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await unlock(password);
      setPassword("");
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Unlock failed",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      open={!!localAccessAccountId && !isUnlocked && !unlockPending}
      onClose={() => {}}
      title="Unlock Terra"
      hideClose
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-dark-400 text-sm">
          Enter your password to decrypt your SSH keys and secrets.
        </p>

        {error && <Alert variant="error">{error}</Alert>}

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg bg-dark-800 border border-dark-700 px-3 py-2.5 text-white placeholder-dark-500 focus:outline-none focus:border-primary-500"
        />

        <Button
          type="submit"
          disabled={isLoading || !password}
          variant="default"
          size="sm"
          className="w-full"
        >
          {isLoading ? "Unlocking..." : "Unlock"}
        </Button>
      </form>
    </Modal>
  );
}
