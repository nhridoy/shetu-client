import { LockSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useAuthStore } from "@/stores/auth/authStore";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";

/**
 * Full-window cover while Shetu is app-locked. Everything else on the page is made inert and
 * no key reaches it, so terminals, dialogs and shortcuts can't be used until the master
 * password unlocks the vault again.
 */
export default function LockScreen() {
  const appLocked = useAuthStore((s) => s.appLocked);
  const unlock = useAuthStore((s) => s.unlock);
  const logout = useAuthStore((s) => s.logout);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cover = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    useShortcutStore.setState({ locked: appLocked });
    if (!appLocked) return;
    const self = cover.current;
    const others = [...document.body.children].filter((el) => el !== self);
    for (const el of others) el.setAttribute("inert", "");
    (document.activeElement as HTMLElement | null)?.blur?.();
    field.current?.focus();
    // Keys aimed anywhere else (a terminal that kept focus) are dropped.
    const block = (e: KeyboardEvent) => {
      if (self && !self.contains(e.target as Node)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    // Keys typed here stop at the cover, so document-level shortcuts and dialogs never see them.
    const contain = (e: Event) => e.stopPropagation();
    window.addEventListener("keydown", block, true);
    self?.addEventListener("keydown", contain);
    self?.addEventListener("keyup", contain);
    return () => {
      for (const el of others) el.removeAttribute("inert");
      window.removeEventListener("keydown", block, true);
      self?.removeEventListener("keydown", contain);
      self?.removeEventListener("keyup", contain);
      useShortcutStore.setState({ locked: false });
    };
  }, [appLocked]);

  if (!appLocked) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={cover}
      role="dialog"
      aria-modal="true"
      aria-label="Shetu is locked"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-dark-950"
    >
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2 text-white">
          <LockSimpleIcon className="w-5 h-5" weight="bold" />
          <h2 className="text-lg font-semibold">Shetu is locked</h2>
        </div>
        <p className="text-sm text-dark-400">
          Enter your password to unlock. Open connections kept running.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        <input
          ref={field}
          type="password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg bg-dark-800 border border-dark-700 px-3 py-2.5 text-white placeholder-dark-500 focus:outline-none focus:border-primary-500"
        />
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void logout()}
          >
            Sign out
          </Button>
          <Button type="submit" size="sm" disabled={busy || !password}>
            Unlock
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
