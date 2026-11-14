import { type Control, type FieldValues, useWatch } from "react-hook-form";
import type { InheritedDefaults } from "@/lib/hosts/inherited";

/** Header summaries for the panel cards, following the form's current values. */
export function useCardSummaries(
  typedControl: Control<never>,
  inherited?: InheritedDefaults,
) {
  const control = typedControl as unknown as Control<FieldValues>;
  const authType = useWatch({ control, name: "authType" });
  const keepaliveMode = useWatch({ control, name: "keepaliveMode" });
  const forwardMode = useWatch({ control, name: "forwardAgentMode" });
  const startupMode = useWatch({ control, name: "startupMode" });
  const env: { name: string }[] = useWatch({ control, name: "env" }) ?? [];
  const from = (on: boolean, group?: string) =>
    on && group ? `from ${group}` : undefined;
  const hidden = inherited?.env.filter(
    (v) => !env.some((r) => r.name === v.name),
  );
  const count = env.length + (hidden?.length ?? 0);
  return {
    credentials: from(authType === "inherit", inherited?.authFrom),
    connection:
      from(keepaliveMode === "default", inherited?.keepaliveFrom) ??
      from(forwardMode === "inherit", inherited?.forwardAgentFrom),
    startup: from(startupMode === "inherit", inherited?.startupFrom),
    env: count > 0 ? `${count} vars` : undefined,
  };
}
