import {
  type Control,
  Controller,
  type FieldValues,
  useFieldArray,
  useWatch,
} from "react-hook-form";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Textarea from "@/components/ui/Textarea";
import type { InheritedDefaults } from "@/lib/hosts/inherited";
import {
  forwardLine,
  keepaliveLine,
  startupLine,
} from "@/lib/hosts/inheritedLabels";
import { AGENT_FORWARD_HELP } from "@/lib/terminal/agentForwarding";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface Props<T extends FieldValues> {
  control: Control<T>;
  mode: "host" | "group";
  inherited?: InheritedDefaults;
}

/**
 * Keepalive, forwarding, env rows and startup. Group mode: "Not set" keepalive/forwarding.
 * Host mode: "From group" choices, and the group's env vars shown read-only.
 */
export default function ConnectionOptionsFields<T extends FieldValues>({
  control: typedControl,
  mode,
  inherited,
}: Props<T>) {
  // Shared by the host and group forms, whose value types differ.
  const control = typedControl as unknown as Control<FieldValues>;
  const snippets = useSnippetStore((s) => s.snippets);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = useFieldArray({ control, name: "env" });
  const keepaliveMode = useWatch({ control, name: "keepaliveMode" });
  const startupMode = useWatch({ control, name: "startupMode" });
  const forwardMode = useWatch({ control, name: "forwardAgentMode" });
  const env: { name: string }[] = useWatch({ control, name: "env" }) ?? [];

  return (
    <div className="space-y-3">
      <FormSelect
        name="keepaliveMode"
        label="Keepalive"
        control={control}
        options={[
          {
            value: "default",
            label: mode === "group" ? "Not set" : "From group",
          },
          { value: "off", label: "Off" },
          { value: "custom", label: "Custom" },
        ]}
      />
      {mode === "host" && keepaliveMode === "default" && (
        <p className="text-xs text-dark-400 -mt-2">
          {keepaliveLine(inherited)}
        </p>
      )}
      {keepaliveMode === "custom" && (
        <FormInput
          name="keepaliveSecs"
          label="Keepalive interval (seconds, 5-600)"
          control={control}
          type="number"
        />
      )}

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
            <p className="text-xs text-dark-400 mt-1">
              {forwardLine(inherited)}
            </p>
          )}
          <p className="text-xs text-dark-400">{AGENT_FORWARD_HELP}</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="block text-dark-300 text-sm mb-2">
          Environment variables
        </legend>
        {inherited?.env.map((v) => {
          const overridden = env.some((row) => row.name === v.name);
          return (
            <p key={v.name} className="text-xs text-dark-400">
              <span className={overridden ? "line-through" : undefined}>
                {v.name}={v.value}
              </span>{" "}
              from {v.from}
              {overridden && " (overridden)"}
            </p>
          );
        })}
        {envFields.map((field, i) => (
          <div key={field.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <FormInput
              name={`env.${i}.name`}
              label="Name"
              control={control}
              placeholder="LANG"
            />
            <FormInput
              name={`env.${i}.value`}
              label="Value"
              control={control}
            />
            <Button
              type="button"
              variant="secondary"
              aria-label={`Remove variable ${i + 1}`}
              onClick={() => removeEnv(i)}
              className="self-end"
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => appendEnv({ name: "", value: "" })}
        >
          Add variable
        </Button>
        <p className="text-xs text-dark-400">
          Servers ignore variables they don't allow (`AcceptEnv` in
          sshd_config); most allow only LANG and LC_*.
        </p>
      </fieldset>

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
        <p className="text-xs text-dark-400 -mt-2">{startupLine(inherited)}</p>
      )}
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
