import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth/authStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useShortcut } from "./useShortcut";

const ACTIVITY = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

/** Locks Shetu after idle time, on Lock now, and on system sleep / screen lock. */
export function useAppLock(): void {
  const active = useAuthStore((s) => s.isUnlocked && !s.appLocked);
  const minutes = useSettingsStore((s) => s.settings.lockAfterIdleMinutes);
  const lock = useCallback(() => {
    void useAuthStore.getState().lockApp();
  }, []);

  useShortcut("app.lock", lock);

  // Only the user's own input resets the timer; terminal output doesn't count.
  useEffect(() => {
    if (!active || minutes <= 0) return;
    let timer = setTimeout(lock, minutes * 60_000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, minutes * 60_000);
    };
    for (const type of ACTIVITY)
      window.addEventListener(type, reset, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY)
        window.removeEventListener(type, reset, { capture: true });
    };
  }, [active, minutes, lock]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("system-lock", () => {
      if (useSettingsStore.getState().settings.lockOnSystemLock) lock();
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [lock]);
}
