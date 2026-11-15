import { create } from "zustand";

interface VariablesAsk {
  id: number;
  names: string[];
  resolve: (values: Record<string, string> | null) => void;
}

/** Pending "Fill in snippet" questions, shown one at a time by SnippetVariablesDialog. */
export const useSnippetVariableAsks = create<{ queue: VariablesAsk[] }>(() => ({
  queue: [],
}));

// Values typed this session, so the next use of a variable starts with them. Memory only.
// A Map, so names like "constructor" never pick up built-in object properties.
export const lastSnippetValues = new Map<string, string>();

let nextAskId = 0;

/** Asks for the variables' values; null when the user cancels. */
export function askSnippetVariables(
  names: string[],
): Promise<Record<string, string> | null> {
  return new Promise((resolve) =>
    useSnippetVariableAsks.setState((s) => ({
      queue: [...s.queue, { id: ++nextAskId, names, resolve }],
    })),
  );
}

export function answerSnippetVariables(values: Record<string, string> | null) {
  const [ask, ...rest] = useSnippetVariableAsks.getState().queue;
  useSnippetVariableAsks.setState({ queue: rest });
  if (values)
    for (const [name, value] of Object.entries(values))
      lastSnippetValues.set(name, value);
  ask?.resolve(values);
}
