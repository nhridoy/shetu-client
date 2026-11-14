import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, useTransition } from "react";
import {
  Controller,
  type FieldErrors,
  useFieldArray,
  useForm,
} from "react-hook-form";
import ModalForm from "@/components/common/ModalForm";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import Textarea from "@/components/ui/Textarea";
import {
  type HostFormValues,
  hostFormDefaultValues,
  hostFormSchema,
} from "@/lib/schema/hosts/hostFormSchema";
import { parseTags } from "@/lib/snippets/parseTags";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export interface HostData {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: "password" | "key" | "both" | "none";
  password?: string;
  keyId?: string;
  jumpHostId?: string | null;
  color?: string;
  groupId?: string;
  tags?: string[];
  keepaliveSecs?: number | null;
  env?: { name: string; value: string }[];
  startup?: { snippetId: string } | { command: string } | null;
}

interface HostFormProps {
  host?: HostData;
  defaultGroupId?: string;
  onClose: () => void;
}

function startupFromForm(data: HostFormValues): HostData["startup"] {
  if (data.startupMode === "snippet" && data.startupSnippetId)
    return { snippetId: data.startupSnippetId };
  const command = data.startupCommand?.trim();
  if (data.startupMode === "command" && command) return { command };
  return null;
}

export default function HostForm({
  host,
  defaultGroupId,
  onClose,
}: HostFormProps) {
  const { createHost, updateHost, groups, hosts } = useHostStore();
  const { currentVaultId } = useVaultStore();
  const keys = useKeyStore((s) => s.keys);
  const snippets = useSnippetStore((s) => s.snippets);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fetchKeys = useKeyStore((s) => s.fetchKeys);
  const [isPending, startTransition] = useTransition();
  const [bastions, setBastions] = useState<
    { id: string; name: string; jumpHostId?: string | null }[]
  >([]);
  const [routeError, setRouteError] = useState<string | null>(null);

  useEffect(() => {
    fetchKeys(currentVaultId ?? undefined);
  }, [fetchKeys, currentVaultId]);

  useEffect(() => {
    let cancelled = false;
    setBastions([]);
    void Promise.allSettled(
      hosts
        .filter(
          (candidate) =>
            candidate.vaultId === currentVaultId && candidate.id !== host?.id,
        )
        .map(async (candidate) =>
          useHostStore.getState().getDecryptedHost(candidate.id),
        ),
    )
      .then((results) => {
        if (!cancelled)
          setBastions(
            results.flatMap((result) =>
              result.status === "fulfilled" &&
              result.value &&
              !result.value.jumpHostId
                ? [result.value]
                : [],
            ),
          );
      })
      .catch((error) => {
        if (!cancelled) setRouteError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [hosts, currentVaultId, host?.id]);

  const { control, handleSubmit, watch, reset } = useForm<HostFormValues>({
    resolver: zodResolver(hostFormSchema),
    defaultValues: {
      name: host?.name || hostFormDefaultValues.name,
      address: host?.address || hostFormDefaultValues.address,
      port: host?.port || hostFormDefaultValues.port,
      username: host?.username || hostFormDefaultValues.username,
      authType: host?.authType || hostFormDefaultValues.authType,
      password: host?.password ?? hostFormDefaultValues.password,
      keyId: host?.keyId || hostFormDefaultValues.keyId,
      jumpHostId: host?.jumpHostId || "",
      color: host?.color || hostFormDefaultValues.color,
      groupId: host?.groupId || defaultGroupId || hostFormDefaultValues.groupId,
      tags: host?.tags ? parseTags(host.tags) : hostFormDefaultValues.tags,
      keepaliveMode:
        host?.keepaliveSecs == null
          ? "default"
          : host.keepaliveSecs === 0
            ? "off"
            : "custom",
      keepaliveSecs: host?.keepaliveSecs || undefined,
      env: host?.env ?? [],
      startupMode: !host?.startup
        ? "none"
        : "snippetId" in host.startup
          ? "snippet"
          : "command",
      startupSnippetId:
        host?.startup && "snippetId" in host.startup
          ? host.startup.snippetId
          : "",
      startupCommand:
        host?.startup && "command" in host.startup ? host.startup.command : "",
    },
  });
  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = useFieldArray({ control, name: "env" });
  const keepaliveMode = watch("keepaliveMode");
  const startupMode = watch("startupMode");

  const authType = watch("authType");
  const selectedJumpHostId = watch("jumpHostId");
  const missingBastion =
    !!selectedJumpHostId &&
    !bastions.some((item) => item.id === selectedJumpHostId);

  const colors = [
    "#64748b",
    "#ef4444",
    "#f59e0b",
    "#22c55e",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#06b6d4",
  ];

  const getButtonText = () => {
    if (isPending) return "Saving...";
    return host ? "Save Changes" : "Add Host";
  };

  const handleHostSubmit = async (data: HostFormValues) => {
    if (
      data.jumpHostId &&
      !bastions.some((item) => item.id === data.jumpHostId)
    ) {
      setRouteError(
        "Selected bastion is unavailable or already uses a jump host",
      );
      return;
    }
    setRouteError(null);
    const hostData = {
      name: data.name,
      address: data.address,
      port: Number(data.port),
      username: data.username,
      authType: data.authType,
      keyId:
        data.authType === "key" || data.authType === "both"
          ? data.keyId
          : undefined,
      jumpHostId: data.jumpHostId || null,
      password:
        data.authType === "password" || data.authType === "both"
          ? data.password
          : undefined,
      color: data.color,
      groupId: data.groupId || undefined,
      vaultId: currentVaultId || undefined,
      tags: data.tags
        ? data.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      keepaliveSecs:
        data.keepaliveMode === "off"
          ? 0
          : data.keepaliveMode === "custom"
            ? Number(data.keepaliveSecs)
            : null,
      env: data.env.filter((row) => row.name !== ""),
      startup: startupFromForm(data),
    };

    if (host) {
      await updateHost(host.id, hostData);
    } else {
      await createHost(hostData);
    }
    reset();
    onClose();
  };

  // Advanced fields unmount while collapsed; reveal them so errors are visible.
  const onInvalid = (errors: FieldErrors<HostFormValues>) => {
    if (errors.keepaliveSecs || errors.startupSnippetId || errors.env)
      setShowAdvanced(true);
  };

  const onSubmit = async (data: HostFormValues) => {
    startTransition(async () => {
      await handleHostSubmit(data);
    });
  };

  return (
    <ModalForm
      onClose={onClose}
      title={host ? "Edit Host" : "Add Host"}
      isPending={isPending}
      onSubmit={handleSubmit(onSubmit, onInvalid)}
      submitButtonText={getButtonText()}
    >
      <FormInput
        name="name"
        label="Name"
        control={control}
        placeholder="My Server"
        required
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <FormInput
            name="address"
            label="Address"
            control={control}
            placeholder="192.168.1.100 or hostname"
            required
          />
        </div>
        <div>
          <FormInput
            name="port"
            label="Port"
            control={control}
            type="number"
            required
          />
        </div>
      </div>

      <FormInput
        name="username"
        label="Username"
        control={control}
        placeholder="root"
        required
      />

      <fieldset>
        <legend className="block text-dark-300 text-sm mb-2">
          Authentication <span className="text-red-400 ml-0.5">*</span>
        </legend>
        <Controller
          name="authType"
          control={control}
          render={({ field }) => (
            <div className="grid grid-cols-4 gap-2">
              {(["password", "key", "both", "none"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  onClick={() => field.onChange(type)}
                  variant={field.value === type ? "default" : "secondary"}
                  className="flex-1"
                >
                  {type === "password"
                    ? "Password"
                    : type === "key"
                      ? "SSH Key"
                      : type === "both"
                        ? "Both"
                        : "None"}
                </Button>
              ))}
            </div>
          )}
        />
      </fieldset>

      {(authType === "password" || authType === "both") && (
        <FormInput
          name="password"
          label="Password"
          control={control}
          type="password"
          placeholder="Enter password"
          required
        />
      )}

      {(authType === "key" || authType === "both") && (
        <FormSelect
          name="keyId"
          label="SSH Key"
          control={control}
          options={[
            { value: "", label: "Select a key" },
            ...keys.map((key) => ({ value: key.id, label: key.name })),
          ]}
          required
        />
      )}

      <FormSelect
        name="jumpHostId"
        label="Connect through"
        control={control}
        options={[
          { value: "", label: "Direct connection" },
          ...bastions.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
          })),
        ]}
      />
      <p className="text-xs text-dark-400">
        The bastion uses its own SSH credentials and host-key check before
        connecting to this host.
      </p>
      {(missingBastion || routeError) && (
        <p role="alert" className="text-xs text-red-400">
          {routeError ??
            "Selected bastion is unavailable. Choose another route before saving."}
        </p>
      )}

      <fieldset>
        <legend className="block text-dark-300 text-sm mb-2">Color</legend>
        <Controller
          name="color"
          control={control}
          render={({ field }) => (
            <div className="flex gap-2">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => field.onChange(c)}
                  className={`cursor-pointer w-8 h-8 rounded-full ${
                    field.value === c
                      ? "ring-2 ring-white ring-offset-2 ring-offset-dark-900"
                      : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}
        />
      </fieldset>

      <FormInput
        name="tags"
        label="Tags"
        control={control}
        placeholder="production, web (comma-separated)"
      />

      {!defaultGroupId && (
        <FormSelect
          name="groupId"
          label="Group"
          control={control}
          options={[
            { value: "", label: "No Group" },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
        />
      )}

      <Button
        type="button"
        variant="secondary"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? "Hide advanced" : "Advanced"}
      </Button>
      {showAdvanced && (
        <div className="space-y-3">
          <FormSelect
            name="keepaliveMode"
            label="Keepalive"
            control={control}
            options={[
              { value: "default", label: "Use default" },
              { value: "off", label: "Off" },
              { value: "custom", label: "Custom" },
            ]}
          />
          {keepaliveMode === "custom" && (
            <FormInput
              name="keepaliveSecs"
              label="Keepalive interval (seconds, 5-600)"
              control={control}
              type="number"
            />
          )}

          <fieldset className="space-y-2">
            <legend className="block text-dark-300 text-sm mb-2">
              Environment variables
            </legend>
            {envFields.map((field, i) => (
              <div
                key={field.id}
                className="grid grid-cols-[1fr_1fr_auto] gap-2"
              >
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
              { value: "none", label: "None" },
              { value: "snippet", label: "Snippet" },
              { value: "command", label: "Command" },
            ]}
          />
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
      )}
    </ModalForm>
  );
}
