import { useEffect } from "react";
import type { ShortcutContext } from "@/lib/shortcuts/registry";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";

/** Marks this view as active so its bindings win over app-wide ones while mounted. */
export function useShortcutContext(
  context: Exclude<ShortcutContext, "app">,
): void {
  useEffect(() => {
    const { setActiveContext } = useShortcutStore.getState();
    setActiveContext(context);
    return () => setActiveContext(null);
  }, [context]);
}
