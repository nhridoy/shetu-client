import { useState } from "react";
import AuthLayout from "@/components/auth/AuthLayout";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import type { SecondFactorKind } from "@/lib/api/twoFactor";
import { useAuthStore } from "@/stores/auth/authStore";

const subtitles: Record<SecondFactorKind, string> = {
  totp: "Enter the 6-digit code from your authenticator app.",
  backup: "Enter one of your backup codes.",
  email: "We sent a code to your email.",
};

/** The second step of a sign-in or recovery: authenticator, backup or emailed code. */
export default function TwoFactorForm() {
  const {
    pendingTwoFactor,
    submitTwoFactor,
    sendTwoFactorEmail,
    cancelTwoFactor,
  } = useAuthStore();
  const [kind, setKind] = useState<SecondFactorKind>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pendingTwoFactor) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: SecondFactorKind) => {
    setKind(next);
    setCode("");
    setError(null);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => submitTwoFactor(code, kind));
  };

  return (
    <AuthLayout title="Two-factor code" subtitle={subtitles[kind]}>
      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1 text-sm text-dark-300">
          <label htmlFor="two-factor-code">
            {kind === "backup" ? "Backup code" : "6-digit code"}
          </label>
          <Input
            id="two-factor-code"
            name="two-factor-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={kind === "backup" ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoFocus
            className="h-9"
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !code.trim()}
        >
          Continue
        </Button>
        <div className="flex flex-col items-start gap-1 text-sm">
          {kind !== "email" && (
            <button
              type="button"
              className="text-primary-400 hover:underline"
              onClick={() => switchTo(kind === "totp" ? "backup" : "totp")}
            >
              {kind === "totp" ? "Use a backup code" : "Use your authenticator"}
            </button>
          )}
          {pendingTwoFactor.path === "recovery" && kind !== "email" && (
            <button
              type="button"
              className="text-primary-400 hover:underline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await sendTwoFactorEmail();
                  switchTo("email");
                })
              }
            >
              Lost your authenticator? Email me a code
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={cancelTwoFactor}
        >
          Cancel
        </Button>
      </form>
    </AuthLayout>
  );
}
