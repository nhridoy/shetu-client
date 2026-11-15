import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import {
  answerSnippetVariables,
  lastSnippetValues,
  useSnippetVariableAsks,
} from "@/stores/snippets/snippetVariablesStore";

/** Asks for a snippet's {{variables}} before it is inserted or run. */
export default function SnippetVariablesDialog() {
  const ask = useSnippetVariableAsks((s) => s.queue[0]);
  if (!ask) return null;
  return (
    <Modal
      onClose={() => answerSnippetVariables(null)}
      title="Fill in snippet"
      zClass="z-[60]"
    >
      {/* Keyed so one snippet's typing never carries into the next ask. */}
      <VariablesForm key={ask.id} names={ask.names} />
    </Modal>
  );
}

function VariablesForm({ names }: { names: string[] }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((n) => [n, lastSnippetValues.get(n) ?? ""])),
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        answerSnippetVariables(values);
      }}
    >
      {names.map((name, i) => (
        <label key={name} className="block">
          <span className="font-mono text-xs text-dark-400">{name}</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
            autoFocus={i === 0}
            name={name}
            type="text"
            autoComplete="off"
            value={values[name]}
            onChange={(e) =>
              setValues((v) => ({ ...v, [name]: e.target.value }))
            }
            className="mt-1 w-full rounded-lg bg-dark-800 px-3 py-2 font-mono text-sm text-white outline-none"
          />
        </label>
      ))}
      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => answerSnippetVariables(null)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Continue
        </Button>
      </div>
    </form>
  );
}
