import { type Control, type FieldValues, useWatch } from "react-hook-form";
import type { InheritedDefaults } from "@/lib/hosts/inherited";

/** Inherited env rows not overridden by a host row of the same name. */
export const visibleInheritedEnv = (
  inherited: InheritedDefaults | undefined,
  env: { name: string }[],
) =>
  inherited?.env.filter((v) => !env.some((row) => row.name === v.name)) ?? [];

/** Header summaries for the panel cards, following the form's current values. */
export function useCardSummaries<T extends FieldValues>(
  typedControl: Control<T>,
  inherited?: InheritedDefaults,
) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const authType = useWatch({ control, name: "authType" });
  const keepalive = useWatch({ control, name: "keepaliveSecs" });
  const forwardMode = useWatch({ control, name: "forwardAgentMode" });
  const startupMode = useWatch({ control, name: "startupMode" });
  const env: { name: string }[] = useWatch({ control, name: "env" }) ?? [];
  const from = (on: boolean, group?: string) =>
    on && group ? `from ${group}` : undefined;
  const count =
    env.filter((r) => r.name?.trim()).length +
    visibleInheritedEnv(inherited, env).length;
  return {
    credentials: from(authType === "inherit", inherited?.authFrom),
    connection:
      from(keepalive == null || keepalive === "", inherited?.keepaliveFrom) ??
      from(forwardMode === "inherit", inherited?.forwardAgentFrom),
    startup: from(startupMode === "inherit", inherited?.startupFrom),
    env: count > 0 ? `${count} ${count === 1 ? "var" : "vars"}` : undefined,
  };
}
