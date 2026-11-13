import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { toCodeMirrorKey } from "@/lib/shortcuts/binding";

/** The editor's Save key, from the user's binding; null when Save has no key. */
export function saveKeymapFor(
  binding: string,
  onSave: () => void,
): Extension | null {
  if (!binding) return null;
  // Highest precedence: the user's Save key wins over the editor's built-in keys.
  return Prec.highest(
    keymap.of([
      {
        key: toCodeMirrorKey(binding),
        run: () => {
          onSave();
          return true;
        },
      },
    ]),
  );
}
