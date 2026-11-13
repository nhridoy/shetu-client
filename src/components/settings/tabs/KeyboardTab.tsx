import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  bindingFromEvent,
  displayBinding,
  hasTypingModifier,
  isShellKey,
} from "@/lib/shortcuts/binding";
import {
  CONTEXT_LABELS,
  SHORTCUTS,
  type ShortcutContext,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts/registry";
import {
  effectiveBinding,
  findConflict,
  shadowedAppShortcut,
  useShortcutStore,
} from "@/stores/shortcuts/shortcutStore";

const CONTEXTS: ShortcutContext[] = ["app", "terminal", "files", "editor"];
const labelOf = (id: ShortcutId) =>
  SHORTCUTS.find((d) => d.id === id)?.label ?? id;
/** macOS terminal copy/paste are the system Edit menu's keys. */
const MAC_SYSTEM_KEYS: Partial<Record<ShortcutId, string>> = {
  "terminal.copy": "⌘C",
  "terminal.paste": "⌘V",
};

type Pending = { id: ShortcutId; binding: string; other: ShortcutId };

export default function KeyboardTab() {
  const mac = navigator.platform.includes("Mac");
  const store = useShortcutStore();
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<{ id: ShortcutId; text: string } | null>(
    null,
  );
  const [pending, setPending] = useState<Pending | null>(null);

  // While recording, every key goes to the recorder: capture on window runs first, and
  // the store's recording flag pauses all shortcuts.
  useEffect(() => {
    if (!recordingId) return;
    const def = SHORTCUTS.find((d) => d.id === recordingId) as ShortcutDef;
    useShortcutStore.getState().setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return; // modifier only: keep waiting
      setRecordingId(null);
      if (def.whileTyping && !hasTypingModifier(binding)) {
        setError({
          id: def.id,
          text: mac
            ? "Add ⌘, ⌥ or ⌃ — this shortcut works while you type."
            : "Add Ctrl or Alt — this shortcut works while you type.",
        });
        return;
      }
      const other = findConflict(def.id, binding, mac);
      if (other) {
        setPending({ id: def.id, binding, other });
        return;
      }
      void useShortcutStore.getState().setBinding(def.id, binding);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      useShortcutStore.getState().setRecording(false);
    };
  }, [recordingId, mac]);

  const startRecording = (id: ShortcutId) => {
    setError(null);
    setPending(null);
    setRecordingId(id);
  };

  const replace = async ({ id, binding, other }: Pending) => {
    setPending(null);
    await store.setBinding(other, "");
    await store.setBinding(id, binding);
  };

  const row = (def: ShortcutDef) => {
    const binding = effectiveBinding(def.id, store, mac);
    const shown = displayBinding(binding, mac);
    const shellWarning =
      def.whileTyping &&
      (def.context === "app" || def.context === "terminal") &&
      binding !== "" &&
      isShellKey(binding);
    const shadowed = shadowedAppShortcut(def.id, mac);
    const rowError = error?.id === def.id ? error.text : null;
    const rowPending = pending?.id === def.id ? pending : null;
    const fixed = mac && def.macFixed;

    return (
      <div
        key={def.id}
        data-shortcut={def.id}
        className="p-3 bg-dark-800 rounded-lg"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-white text-sm">{def.label}</span>
          {fixed ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="font-mono text-dark-200">
                {MAC_SYSTEM_KEYS[def.id]}
              </span>
              <span className="text-xs text-dark-400">System</span>
            </span>
          ) : (
            <div className="flex items-center gap-1">
              {store.overrides[def.id] !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void store.resetBinding(def.id)}
                >
                  Reset
                </Button>
              )}
              {binding !== "" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void store.setBinding(def.id, "")}
                >
                  Clear
                </Button>
              )}
              <Button
                type="button"
                data-cap
                variant="secondary"
                size="sm"
                className="font-mono min-w-24"
                aria-label={`Change ${def.label} shortcut`}
                onClick={() => startRecording(def.id)}
              >
                {recordingId === def.id ? "Press keys…" : shown || "None"}
              </Button>
            </div>
          )}
        </div>
        {rowError && <p className="mt-2 text-xs text-red-400">{rowError}</p>}
        {rowPending && (
          <div className="mt-2 flex items-center gap-2 text-xs text-amber-300">
            <span>Already used by {labelOf(rowPending.other)}.</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void replace(rowPending)}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        )}
        {shellWarning && (
          <p className="mt-2 text-xs text-amber-300">
            The terminal won't receive {shown}.
          </p>
        )}
        {shadowed && (
          <p className="mt-2 text-xs text-dark-400">
            Overrides {labelOf(shadowed)} in the {CONTEXT_LABELS[def.context]}.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {CONTEXTS.map((context, i) => (
        <div
          key={context}
          className={i ? "border-t border-dark-700 pt-6" : undefined}
        >
          <h3 className="text-sm font-medium text-white mb-3">
            {CONTEXT_LABELS[context]}
          </h3>
          <div className="space-y-2">
            {SHORTCUTS.filter((d) => d.context === context).map(row)}
          </div>
        </div>
      ))}
      <div className="border-t border-dark-700 pt-6 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void store.resetAll()}
        >
          Reset all
        </Button>
      </div>
    </div>
  );
}
