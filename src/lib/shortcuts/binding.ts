/**
 * Key bindings as canonical strings: modifiers in the order ctrl+alt+shift+meta, then one
 * key named after its physical position (`event.code`), e.g. "ctrl+shift+backslash".
 * "" means no binding. "mod" (registry defaults only) is Cmd on macOS, Ctrl elsewhere.
 */

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;
const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

type KeyInput = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

/** "KeyT" → "t", "Digit1" → "1", "Backslash" → "backslash". */
const keyName = (code: string) =>
  code.toLowerCase().replace(/^(key|digit)/, "");

function canonical(parts: string[]): string {
  const key = parts.filter(
    (p) => !(MODIFIERS as readonly string[]).includes(p),
  );
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  return [...mods, ...key].join("+");
}

export function resolveMod(binding: string, mac: boolean): string {
  if (!binding) return "";
  const parts = binding
    .split("+")
    .map((p) => (p === "mod" ? (mac ? "meta" : "ctrl") : p));
  return canonical(parts);
}

export function bindingFromEvent(e: KeyInput): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  parts.push(keyName(e.code));
  return parts.join("+");
}

export function isValidBinding(b: string): boolean {
  if (b === "") return true;
  const parts = b.split("+");
  const key = parts[parts.length - 1];
  if (
    !/^[a-z0-9]+$/.test(key) ||
    (MODIFIERS as readonly string[]).includes(key)
  )
    return false;
  const mods = parts.slice(0, -1);
  // Canonical: only known modifiers, each at most once, in MODIFIERS order.
  return (
    mods.every((m) => (MODIFIERS as readonly string[]).includes(m)) &&
    canonical(parts) === b &&
    new Set(mods).size === mods.length
  );
}

export function matchesBinding(e: KeyInput, binding: string): boolean {
  return binding !== "" && bindingFromEvent(e) === binding;
}

const split = (b: string) => {
  const parts = b.split("+");
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
};

const KEY_LABELS: Record<string, string> = {
  backslash: "\\",
  comma: ",",
  slash: "/",
  period: ".",
  minus: "-",
  equal: "=",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
  delete: "Del",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (key.length === 1 || /^f\d+$/.test(key)) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

const MAC_SYMBOLS: Record<string, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};
const WORDS: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

export function displayBinding(binding: string, mac: boolean): string {
  if (!binding) return "";
  const { mods, key } = split(binding);
  if (mac) return mods.map((m) => MAC_SYMBOLS[m]).join("") + keyLabel(key);
  return [...mods.map((m) => WORDS[m]), keyLabel(key)].join("+");
}

/** CodeMirror keymap syntax: "Shift-Meta-s". */
export function toCodeMirrorKey(binding: string): string {
  const { mods, key } = split(binding);
  const name = key.length === 1 ? key : (KEY_LABELS[key] ?? keyLabel(key));
  return [...mods.map((m) => WORDS[m]), name === "Del" ? "Delete" : name].join(
    "-",
  );
}

/** Tauri menu accelerator syntax: "Shift+Cmd+T". */
export function toTauriAccelerator(binding: string): string | null {
  if (!binding) return null;
  const { mods, key } = split(binding);
  const word = (m: string) => (m === "meta" ? "Cmd" : WORDS[m]);
  const name = keyLabel(key);
  return [...mods.map(word), name === "Del" ? "Delete" : name].join("+");
}

/** True when the binding can't be typed as text: has Ctrl/Alt/Meta, or is an F-key. */
export function hasTypingModifier(binding: string): boolean {
  const { mods, key } = split(binding);
  return mods.some((m) => m !== "shift") || /^f\d+$/.test(key);
}

/** Keys shells use: plain Ctrl+letter (e.g. Ctrl+R) or Alt+letter (readline Meta). */
export function isShellKey(binding: string): boolean {
  const { mods, key } = split(binding);
  if (!/^[a-z]$/.test(key)) return false;
  const m = mods.join("+");
  return m === "ctrl" || m === "alt" || m === "alt+shift";
}
