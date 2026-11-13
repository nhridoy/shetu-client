import { load } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  displayBinding,
  hasTypingModifier,
  isValidBinding,
  matchesBinding,
  resolveMod,
} from "@/lib/shortcuts/binding";
import {
  SHORTCUTS,
  type ShortcutContext,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts/registry";
import { hasMacMenu } from "@/lib/window/menuActions";

const STORE_FILE = "settings.json";
const STORE_KEY = "shortcuts";

type Overrides = Partial<Record<ShortcutId, string>>;

export interface ShortcutState {
  /** Only the user's changes; "" = no key. */
  overrides: Overrides;
  /** The mounted view; its bindings win over app-wide ones. */
  activeContext: ShortcutContext | null;
  /** The Keyboard tab is capturing keys: every shortcut pauses. */
  recording: boolean;
  initShortcuts(): Promise<void>;
  setBinding(id: ShortcutId, binding: string): Promise<void>;
  resetBinding(id: ShortcutId): Promise<void>;
  resetAll(): Promise<void>;
  setActiveContext(c: ShortcutContext | null): void;
  setRecording(on: boolean): void;
}

const isMac = () => navigator.platform.includes("Mac");
const DEFS = new Map(SHORTCUTS.map((d) => [d.id, d]));
const defOf = (id: ShortcutId) => DEFS.get(id) as ShortcutDef;
const defaultBinding = (d: ShortcutDef, mac: boolean) =>
  resolveMod(mac ? d.mac : d.other, mac);

async function persist(overrides: Overrides): Promise<void> {
  try {
    const store = await load(STORE_FILE, { autoSave: false });
    await store.set(STORE_KEY, overrides);
    await store.save();
  } catch {
    // best-effort: the in-memory bindings still apply for this session
  }
}

/** Keeps only what the Keyboard tab could have saved: known ids, valid bindings, and
 * no bare keys for shortcuts that fire while typing. */
function sanitize(value: unknown): Overrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Overrides = {};
  for (const [id, b] of Object.entries(value)) {
    const def = DEFS.get(id as ShortcutId);
    if (
      def &&
      typeof b === "string" &&
      isValidBinding(b) &&
      !(def.whileTyping && b !== "" && !hasTypingModifier(b))
    )
      out[def.id] = b;
  }
  return out;
}

export const useShortcutStore = create<ShortcutState>((set, get) => {
  const save = (overrides: Overrides) => {
    set({ overrides });
    return persist(overrides);
  };
  return {
    overrides: {},
    activeContext: null,
    recording: false,

    initShortcuts: async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: false });
        set({ overrides: sanitize(await store.get(STORE_KEY)) });
      } catch {
        set({ overrides: {} });
      }
    },

    setBinding: async (id, binding) => {
      if (!isValidBinding(binding)) return;
      const { [id]: _, ...rest } = get().overrides;
      await save(
        binding === defaultBinding(defOf(id), isMac())
          ? rest
          : { ...rest, [id]: binding },
      );
    },

    resetBinding: async (id) => {
      const { [id]: _, ...rest } = get().overrides;
      await save(rest);
    },

    resetAll: () => save({}),
    setActiveContext: (activeContext) => set({ activeContext }),
    setRecording: (recording) => set({ recording }),
  };
});

/** The binding in force: the user's override, else the platform default. */
export function effectiveBinding(
  id: ShortcutId,
  s: Pick<ShortcutState, "overrides"> = useShortcutStore.getState(),
  mac = isMac(),
): string {
  const d = defOf(id);
  if (mac && d.macFixed) return "";
  return s.overrides[id] ?? defaultBinding(d, mac);
}

/** Another shortcut that would fire on the same key at the same time, if any. */
export function findConflict(
  id: ShortcutId,
  binding: string,
  mac = isMac(),
): ShortcutId | null {
  if (!binding) return null;
  const me = defOf(id);
  for (const o of SHORTCUTS) {
    if (o.id === id || effectiveBinding(o.id, undefined, mac) !== binding)
      continue;
    if (o.context === me.context) return o.id;
    // macOS menu-bar keys fire on every page.
    if (mac && (o.menuItem || me.menuItem)) return o.id;
    // Otherwise a view reusing an app-wide key shadows it (see shadowedAppShortcut).
  }
  return null;
}

/** The app-wide shortcut this view shortcut overrides while its view is active. */
export function shadowedAppShortcut(
  id: ShortcutId,
  mac = isMac(),
): ShortcutId | null {
  const me = defOf(id);
  const binding = effectiveBinding(id, undefined, mac);
  if (me.context === "app" || !binding) return null;
  const app = SHORTCUTS.find(
    (a) =>
      a.context === "app" &&
      !(mac && a.menuItem) &&
      effectiveBinding(a.id, undefined, mac) === binding,
  );
  return app?.id ?? null;
}

/** App-wide and terminal shortcuts that work while typing never reach the shell. */
export function isHeldBackFromTerminal(
  e: KeyboardEvent,
  mac = isMac(),
): boolean {
  return SHORTCUTS.some(
    (d) =>
      d.whileTyping &&
      (d.context === "app" || d.context === "terminal") &&
      matchesBinding(e, effectiveBinding(d.id, undefined, mac)),
  );
}

export function isShortcutDisabled(id: ShortcutId): boolean {
  const d = defOf(id);
  return (
    useShortcutStore.getState().recording ||
    effectiveBinding(id) === "" ||
    // The macOS menu bar fires these itself.
    (!!d.menuItem && hasMacMenu())
  );
}

/** Menu label for a shortcut's current key; undefined when it has none. */
export function shortcutLabel(
  id: ShortcutId,
  mac = isMac(),
): string | undefined {
  return displayBinding(effectiveBinding(id, undefined, mac), mac) || undefined;
}
