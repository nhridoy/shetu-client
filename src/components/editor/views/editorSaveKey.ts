import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { toCodeMirrorKey } from "@/lib/shortcuts/binding";

/** The editor's Save key, from the user's binding; null when Save has no key. */
export function saveKeymapFor(
  binding: string,
  onSave: () => void,
): Extension | null {
  if (!binding) return null;
  return keymap.of([
    {
      key: toCodeMirrorKey(binding),
      run: () => {
        onSave();
        return true;
      },
    },
  ]);
}
