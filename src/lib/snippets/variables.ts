/** `{{name}}` placeholders in a snippet command. */
const VARIABLE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

/** Variable names in order of first use, each once. */
export function snippetVariables(command: string): string[] {
  return [...new Set([...command.matchAll(VARIABLE)].map((m) => m[1]))];
}

/** The command with each variable replaced by its value (taken literally). */
export function fillSnippet(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(VARIABLE, (whole, name: string) =>
    name in values ? values[name] : whole,
  );
}
