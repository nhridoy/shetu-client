import { useHotkeys } from "react-hotkeys-hook";
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts/registry";
import { hasMacMenu } from "@/lib/window/menuActions";
import {
  effectiveBinding,
  shadowedAppShortcut,
  useShortcutStore,
} from "@/stores/shortcuts/shortcutStore";

const DEFS = new Map(SHORTCUTS.map((d) => [d.id, d]));

/** Runs `callback` when the user's binding for `id` is pressed. */
export function useShortcut(
  id: ShortcutId,
  callback: (e: KeyboardEvent) => void,
  options: {
    enabled?: boolean;
    capture?: boolean;
    /** Also fire inside contenteditable (the code editor) even when not while-typing. */
    contentEditable?: boolean;
  } = {},
): void {
  const def = DEFS.get(id);
  if (!def) throw new Error(`unknown shortcut ${id}`);
  const binding = useShortcutStore((s) => effectiveBinding(id, s));
  const recording = useShortcutStore((s) => s.recording);
  // An app-wide key reused by the mounted view belongs to the view there.
  const shadowed = useShortcutStore(
    (s) =>
      def.context === "app" &&
      s.activeContext !== null &&
      SHORTCUTS.some(
        (o) =>
          o.context === s.activeContext && shadowedAppShortcut(o.id) === id,
      ),
  );
  const enabled =
    binding !== "" &&
    !recording &&
    !shadowed &&
    options.enabled !== false &&
    // The macOS menu bar fires these itself.
    !(def.menuItem && hasMacMenu());

  useHotkeys(
    binding,
    (e) => callback(e),
    {
      enabled,
      enableOnFormTags: def.whileTyping,
      enableOnContentEditable: def.whileTyping || !!options.contentEditable,
      preventDefault: true,
      eventListenerOptions: options.capture ? { capture: true } : undefined,
    },
    [callback],
  );
}
