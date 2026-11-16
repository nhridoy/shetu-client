import { LockSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import TitleBar from "@/components/layout/shell/TitleBar";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useAuthStore } from "@/stores/auth/authStore";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";

/** Window event whose detail is shown on the lock screen (e.g. why closing didn't happen). */
export const LOCK_NOTICE_EVENT = "shetu:lock-notice";

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
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Why something the user tried (e.g. closing the window) didn't happen while locked.
  const [notice, setNotice] = useState<string | null>(null);
  const cover = useRef<HTMLDivElement>(null);
  // Each lock is a new cycle; an unlock attempt from an earlier one must not touch this form.
  const cycle = useRef(0);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    useShortcutStore.setState({ locked: appLocked });
    if (!appLocked) return;
    cycle.current++;
    // Toasts sit above everything and could show host names or file paths.
    toast.dismiss();
    const self = cover.current;
    const previous = document.activeElement as HTMLElement | null;
    const others = [...document.body.children].filter((el) => el !== self);
    for (const el of others) el.setAttribute("inert", "");
    (document.activeElement as HTMLElement | null)?.blur?.();
    field.current?.focus();
    // Keys aimed anywhere else (a terminal that kept focus) are dropped.
    const block = (e: KeyboardEvent) => {
      if (self && !self.contains(e.target as Node)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // e.g. a click on the backdrop moved focus away: bring the keyboard back.
        field.current?.focus();
      }
    };
    const onNotice = (e: Event) => setNotice((e as CustomEvent<string>).detail);
    window.addEventListener(LOCK_NOTICE_EVENT, onNotice);
    // Keys typed here stop at the cover, so document-level shortcuts and dialogs never see them.
    const contain = (e: Event) => e.stopPropagation();
    window.addEventListener("keydown", block, true);
    self?.addEventListener("keydown", contain);
    self?.addEventListener("keyup", contain);
    return () => {
      window.removeEventListener(LOCK_NOTICE_EVENT, onNotice);
      // Nothing typed here outlives the lock.
      setPassword("");
      setError(null);
      setBusy(false);
      setConfirmSignOut(false);
      setNotice(null);
      for (const el of others) el.removeAttribute("inert");
      if (previous?.isConnected) previous.focus();
      window.removeEventListener("keydown", block, true);
      self?.removeEventListener("keydown", contain);
      self?.removeEventListener("keyup", contain);
      useShortcutStore.setState({ locked: false });
    };
  }, [appLocked]);

  if (!appLocked) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const mine = cycle.current;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      if (mine === cycle.current) setPassword("");
    } catch (err) {
      if (mine === cycle.current)
        setError(err instanceof Error ? err.message : String(err));
    }
    // An attempt from an earlier lock leaves the current form alone.
    if (mine !== cycle.current) return;
    setBusy(false);
    // The disabled Unlock button dropped focus; keep typing in the field.
    setTimeout(() => field.current?.focus(), 0);
    field.current?.focus();
  };

  return createPortal(
    <div
      ref={cover}
      role="dialog"
      aria-modal="true"
      aria-label="Shetu is locked"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-dark-950"
    >
      {/* The window has no OS frame: keep moving, minimising and closing it possible. */}
      <TitleBar />
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2 text-white">
          <LockSimpleIcon className="w-5 h-5" weight="bold" />
          <h2 className="text-lg font-semibold">Shetu is locked</h2>
        </div>
        <p className="text-sm text-dark-400">
          Enter your password to unlock. Open connections kept running.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="error">{notice}</Alert>}
        <input
          ref={field}
          type="password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg bg-dark-800 border border-dark-700 px-3 py-2.5 text-white placeholder-dark-500 focus:outline-none focus:border-primary-500"
        />
        {confirmSignOut ? (
          <div className="space-y-3 rounded-lg border border-dark-700 p-3">
            <p className="text-sm text-dark-300">
              Sign out? Unsaved changes and open sessions will be lost.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmSignOut(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void logout()}
              >
                Sign out anyway
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmSignOut(true)}
            >
              Sign out
            </Button>
            <Button type="submit" size="sm" disabled={busy || !password}>
              Unlock
            </Button>
          </div>
        )}
      </form>
    </div>,
    document.body,
  );
}
