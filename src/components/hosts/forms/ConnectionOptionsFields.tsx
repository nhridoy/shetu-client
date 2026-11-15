import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  type Control,
  Controller,
  type FieldValues,
  type UseFieldArrayReturn,
  useFieldArray,
  useWatch,
} from "react-hook-form";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Textarea from "@/components/ui/Textarea";
import type { InheritedDefaults } from "@/lib/hosts/inherited";
import {
  forwardLine,
  keepalivePlaceholder,
  startupLine,
} from "@/lib/hosts/inheritedLabels";
import { snippetVariables } from "@/lib/snippets/variables";
import { AGENT_FORWARD_HELP } from "@/lib/terminal/agentForwarding";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { visibleInheritedEnv } from "./useCardSummaries";

export type EnvArray = UseFieldArrayReturn<FieldValues, "env">;

/** Owned by the form so the card header's Add button and the env table share one array. */
export function useEnvArray<T extends FieldValues>(control: Control<T>) {
  return useFieldArray({
    control: control as unknown as Control<FieldValues>,
    name: "env",
  });
}

export function EnvAddButton({ envArray }: { envArray: EnvArray }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-env-add
      onClick={() => envArray.append({ name: "", value: "" })}
    >
      <PlusIcon /> Add variable
    </Button>
  );
}

interface Props<T extends FieldValues> {
  control: Control<T>;
  mode: "host" | "group";
  inherited?: InheritedDefaults;
  /** Which card this renders: keepalive + forwarding, startup, or the env table. */
  part: "connection" | "startup" | "env";
  /** Required for part="env". */
  envArray?: EnvArray;
}

/**
 * Keepalive + forwarding, startup, or env rows, per `part`. Group mode: "Not set" keepalive/forwarding.
 * Host mode: "From group" choices, and the group's env vars shown read-only.
 */
export default function ConnectionOptionsFields<T extends FieldValues>({
  control: typedControl,
  mode,
  inherited,
  part,
  envArray,
}: Props<T>) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const snippets = useSnippetStore((s) => s.snippets);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = envArray ?? { fields: [], append: () => {}, remove: () => {} };
  const startupMode = useWatch({ control, name: "startupMode" });
  const startupSnippetId = useWatch({ control, name: "startupSnippetId" });
  // A {{variables}} snippet can't be filled at connect time, so it won't run there.
  const [startupHasVariables, setStartupHasVariables] = useState(false);
  useEffect(() => {
    setStartupHasVariables(false);
    if (startupMode !== "snippet" || !startupSnippetId) return;
    let live = true;
    void useSnippetStore
      .getState()
      .getDecryptedSnippet(startupSnippetId)
      .then(
        (s) =>
          live &&
          setStartupHasVariables(snippetVariables(s?.command ?? "").length > 0),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [startupMode, startupSnippetId]);
  const forwardMode = useWatch({ control, name: "forwardAgentMode" });
  const env: { name: string }[] = useWatch({ control, name: "env" }) ?? [];
  const visibleInherited = visibleInheritedEnv(inherited, env);

  // A removed row takes its focused button with it; hand focus to the next row or Add.
  const envRef = useRef<HTMLFieldSetElement>(null);
  const refocusRow = useRef<number | null>(null);
  useEffect(() => {
    const i = refocusRow.current;
    if (i === null) return;
    refocusRow.current = null;
    const root = envRef.current;
    (
      root?.querySelector<HTMLElement>(
        `[aria-label="Remove variable ${i + 1}"]`,
      ) ??
      root?.closest("section")?.querySelector<HTMLElement>("[data-env-add]")
    )?.focus();
  });

  if (part === "connection")
    return (
      <div className="space-y-3">
        {mode === "group" && (
          <FormInput
            name="port"
            label="Port"
            control={control}
            type="number"
            placeholder="Not set"
          />
        )}
        <div>
          <FormInput
            name="keepaliveSecs"
            label="Keepalive"
            control={control}
            type="number"
            placeholder={
              mode === "host" ? keepalivePlaceholder(inherited) : "Not set"
            }
          />
          <p className="mt-1 text-xs text-dark-500">
            Seconds. Empty uses the {mode === "group" ? "parent " : ""}group or
            default; 0 turns it off.
          </p>
        </div>

        {mode === "group" ? (
          <FormSelect
            name="forwardAgent"
            label="Forward SSH agent"
            control={control}
            options={[
              { value: "unset", label: "Not set" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        ) : (
          <div>
            <FormSelect
              name="forwardAgentMode"
              label="Forward SSH agent"
              control={control}
              options={[
                { value: "inherit", label: "From group" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
            {forwardMode === "inherit" && (
              <p className="mt-1 text-xs text-dark-300">
                {forwardLine(inherited)}
              </p>
            )}
            <p className="mt-1 text-xs text-dark-500">{AGENT_FORWARD_HELP}</p>
          </div>
        )}
      </div>
    );

  if (part === "env")
    return (
      <fieldset ref={envRef} className="space-y-2">
        <legend className="sr-only">Environment variables</legend>
        {(envFields.length > 0 || visibleInherited.length > 0) && (
          <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-x-2 gap-y-0">
            <span data-env-header className="pl-[9px] text-xs text-dark-400">
              Name
            </span>
            <span data-env-header className="pl-[9px] text-xs text-dark-400">
              Value
            </span>
            <span className="w-0" />
            {visibleInherited.map((v) => (
              <div
                key={v.name}
                data-inherited-env={v.name}
                className="col-span-3 mt-2 grid h-7 grid-cols-subgrid items-center text-sm text-dark-400"
              >
                <span className="flex min-w-0 items-center gap-1.5 pl-[9px]">
                  <span className="truncate">{v.name}</span>
                  <Badge className="max-w-20 shrink-0">
                    <span className="truncate">{v.from}</span>
                  </Badge>
                </span>
                <span className="truncate pl-[9px]" title={v.value}>
                  {v.value}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Override ${v.name}`}
                  onClick={() =>
                    appendEnv(
                      { name: v.name, value: v.value },
                      { focusName: `env.${envFields.length}.value` },
                    )
                  }
                >
                  Override
                </Button>
              </div>
            ))}
            {envFields.map((field, i) => {
              const from = inherited?.env.find(
                (v) => v.name === env[i]?.name,
              )?.from;
              return (
                <div
                  key={field.id}
                  className="col-span-3 grid grid-cols-subgrid items-start"
                >
                  <div>
                    <FormInput
                      name={`env.${i}.name`}
                      label={<span className="sr-only">{`Name ${i + 1}`}</span>}
                      control={control}
                      placeholder="NAME"
                    />
                    {from && (
                      <span className="mt-1 block text-xs text-dark-400">
                        overrides {from}
                      </span>
                    )}
                  </div>
                  <FormInput
                    name={`env.${i}.value`}
                    label={<span className="sr-only">{`Value ${i + 1}`}</span>}
                    control={control}
                    placeholder="value"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove variable ${i + 1}`}
                    onClick={() => {
                      refocusRow.current = i;
                      removeEnv(i);
                    }}
                    className="mt-3 justify-self-end"
                  >
                    <TrashIcon />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-dark-500">
          Servers ignore variables they don't allow (<code>AcceptEnv</code> in
          sshd_config); most allow only LANG and LC_*.
        </p>
      </fieldset>
    );

  return (
    <div className="space-y-3">
      <div>
        <FormSelect
          name="startupMode"
          label="On connect"
          control={control}
          options={[
            ...(mode === "host"
              ? [{ value: "inherit", label: "From group" }]
              : []),
            { value: "none", label: mode === "host" ? "None" : "Not set" },
            { value: "snippet", label: "Snippet" },
            { value: "command", label: "Command" },
          ]}
        />
        {mode === "host" && startupMode === "inherit" && (
          <p className="mt-1 text-xs text-dark-300">{startupLine(inherited)}</p>
        )}
      </div>
      {startupMode === "snippet" && (
        <FormSelect
          name="startupSnippetId"
          label="Snippet"
          control={control}
          options={[
            { value: "", label: "Select a snippet" },
            ...snippets
              .filter((sn) => sn.vaultId === currentVaultId)
              .map((sn) => ({ value: sn.id, label: sn.name })),
          ]}
        />
      )}
      {startupMode === "snippet" && startupHasVariables && (
        <p role="alert" className="mt-1 text-xs text-amber-400">
          This snippet has {"{{variables}}"}, so it won't run on connect.
        </p>
      )}
      {startupMode === "command" && (
        <Controller
          name="startupCommand"
          control={control}
          render={({ field }) => (
            <Textarea
              {...field}
              value={field.value ?? ""}
              aria-label="Startup command"
              rows={3}
              placeholder="cd /var/www && ls"
            />
          )}
        />
      )}
    </div>
  );
}
