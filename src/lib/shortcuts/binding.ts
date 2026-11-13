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

/** Keys as other tools name them (Tauri menu accelerators, CodeMirror). */
const NAMED_KEYS: Record<string, string> = {
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  delete: "Delete",
  backspace: "Backspace",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  home: "Home",
  end: "End",
  insert: "Insert",
};
const PUNCTUATION = [
  "backslash",
  "comma",
  "slash",
  "period",
  "minus",
  "equal",
  "semicolon",
  "quote",
  "backquote",
  "bracketleft",
  "bracketright",
];

/** Letters, digits, F1–F24, punctuation and the named keys above. */
const isSupportedKey = (key: string) =>
  /^([a-z0-9]|f([1-9]|1\d|2[0-4]))$/.test(key) ||
  Object.hasOwn(NAMED_KEYS, key) ||
  PUNCTUATION.includes(key);

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
  // Modifier-only presses and keys we can't name everywhere (numpad, CapsLock…).
  if (
    !e.code ||
    MODIFIER_CODES.test(e.code) ||
    !isSupportedKey(keyName(e.code))
  )
    return null;
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
  if (!isSupportedKey(key)) return false;
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
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
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

/** CodeMirror keymap syntax: "Shift-Meta-s", "Ctrl-PageUp". */
export function toCodeMirrorKey(binding: string): string {
  const { mods, key } = split(binding);
  const name = key.length === 1 ? key : (NAMED_KEYS[key] ?? keyLabel(key));
  return [...mods.map((m) => WORDS[m]), name].join("-");
}

/** Tauri menu accelerator syntax: "Shift+Cmd+T", "Cmd+PageUp". */
export function toTauriAccelerator(binding: string): string | null {
  if (!binding) return null;
  const { mods, key } = split(binding);
  const word = (m: string) => (m === "meta" ? "Cmd" : WORDS[m]);
  return [...mods.map(word), NAMED_KEYS[key] ?? keyLabel(key)].join("+");
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
