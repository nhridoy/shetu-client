import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  GlobeIcon,
  KeyIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import SidePanel from "@/components/common/SidePanel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import { FormSelect } from "@/components/ui/forms/FormSelect";
import {
  fetchInheritedDefaults,
  type InheritedDefaults,
} from "@/lib/hosts/inherited";
import { portLine } from "@/lib/hosts/inheritedLabels";
import {
  type HostFormValues,
  hostFormDefaultValues,
  hostFormSchema,
  isBlank,
} from "@/lib/schema/hosts/hostFormSchema";
import { parseTags } from "@/lib/snippets/parseTags";
import { recordAgentForwarding } from "@/lib/terminal/agentForwarding";
import { type Startup, useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import ConnectionOptionsFields, {
  EnvAddButton,
  useEnvArray,
} from "./ConnectionOptionsFields";
import CredentialsFields from "./CredentialsFields";
import { useCardSummaries } from "./useCardSummaries";

export interface HostData {
  id: string;
  name: string;
  address: string;
  port: number | null;
  username: string;
  authType: "inherit" | "password" | "key" | "both" | "none" | "identity";
  identityId?: string | null;
  password?: string;
  keyId?: string;
  jumpHostId?: string | null;
  color?: string;
  groupId?: string;
  tags?: string[];
  keepaliveSecs?: number | null;
  forwardAgent?: boolean | null;
  env?: { name: string; value: string }[];
  startup?: Startup;
}

interface HostFormProps {
  host?: HostData;
  defaultGroupId?: string;
  onClose: () => void;
}

function startupFromForm(data: HostFormValues): HostData["startup"] {
  if (data.startupMode === "inherit") return null;
  if (data.startupMode === "snippet" && data.startupSnippetId)
    return { snippetId: data.startupSnippetId };
  const command = data.startupCommand?.trim();
  if (data.startupMode === "command" && command) return { command };
  return { none: true };
}

const FORWARD = { inherit: null, on: true, off: false } as const;

export default function HostForm({
  host,
  defaultGroupId,
  onClose,
}: HostFormProps) {
  const { createHost, updateHost, groups, hosts } = useHostStore();
  const { currentVaultId } = useVaultStore();
  const fetchSnippets = useSnippetStore((s) => s.fetchSnippets);
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
    fetchSnippets(currentVaultId ?? undefined);
  }, [fetchSnippets, currentVaultId]);

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

  const [inherited, setInherited] = useState<InheritedDefaults>();
  const initialGroupId = host?.groupId || defaultGroupId || "";
  const isNew = !host;
  const {
    control,
    handleSubmit,
    watch,
    reset,
    resetField,
    setValue,
    setFocus,
    formState: { isDirty },
  } = useForm<HostFormValues>({
    resolver: zodResolver(hostFormSchema),
    defaultValues: {
      name: host?.name || hostFormDefaultValues.name,
      address: host?.address || hostFormDefaultValues.address,
      port: host?.port ?? hostFormDefaultValues.port,
      username: host?.username || hostFormDefaultValues.username,
      authType: host?.authType || hostFormDefaultValues.authType,
      identityId: host?.identityId || hostFormDefaultValues.identityId,
      password: host?.password ?? hostFormDefaultValues.password,
      keyId: host?.keyId || hostFormDefaultValues.keyId,
      jumpHostId: host?.jumpHostId || "",
      color: host?.color || hostFormDefaultValues.color,
      groupId: initialGroupId,
      tags: host?.tags ? parseTags(host.tags) : hostFormDefaultValues.tags,
      keepaliveSecs: host?.keepaliveSecs ?? "",
      forwardAgentMode: host
        ? host.forwardAgent == null
          ? "inherit"
          : host.forwardAgent
            ? "on"
            : "off"
        : initialGroupId
          ? "inherit"
          : "off",
      env: host?.env ?? [],
      startupMode: !host
        ? initialGroupId
          ? "inherit"
          : "none"
        : !host.startup
          ? "inherit"
          : "none" in host.startup
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
  const selectedJumpHostId = watch("jumpHostId");
  const groupId = watch("groupId") ?? "";

  // Fields the user picked themselves; group changes never overwrite them.
  const userSet = useRef(new Set<string>());
  useEffect(() => {
    const sub = watch((_, { name, type }) => {
      if (type === "change" && name) userSet.current.add(name);
    });
    return () => sub.unsubscribe();
  }, [watch]);

  useEffect(() => {
    let stale = false;
    // Drop the previous group's values until the new ones arrive.
    setInherited(undefined);
    const apply = (d: InheritedDefaults | undefined) => {
      if (!stale) setInherited(d);
    };
    // Untouched mode defaults follow the group right away, not after the lookup,
    // so a save before it resolves doesn't store explicit none/off.
    if (isNew) {
      const defaults = {
        authType: groupId ? "inherit" : "none",
        startupMode: groupId ? "inherit" : "none",
        forwardAgentMode: groupId ? "inherit" : "off",
      } as const;
      // resetField moves the baseline too, so these defaults never count as edits.
      for (const [name, value] of Object.entries(defaults))
        if (!userSet.current.has(name))
          resetField(name as keyof typeof defaults, { defaultValue: value });
    }
    if (groupId && currentVaultId)
      fetchInheritedDefaults(groupId, currentVaultId).then(apply, () =>
        apply(undefined),
      );
    else apply(undefined);
    return () => {
      stale = true;
    };
  }, [groupId, currentVaultId, isNew, resetField]);

  const authType = watch("authType");
  // The identity supplies the username, so the host's own one would be ignored.
  const usesIdentity =
    authType === "identity" ||
    (authType === "inherit" && inherited?.authType === "identity");

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
    const forwardAgent = FORWARD[data.forwardAgentMode];
    const hostData = {
      name: data.name || data.address,
      address: data.address,
      port: isBlank(data.port) ? null : Number(data.port),
      username: data.username,
      authType: data.authType,
      identityId: data.authType === "identity" ? data.identityId : null,
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
      groupId: data.groupId || null,
      vaultId: currentVaultId || undefined,
      tags: data.tags
        ? data.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      keepaliveSecs: isBlank(data.keepaliveSecs)
        ? null
        : Number(data.keepaliveSecs),
      forwardAgent,
      env: data.env.filter((row) => row.name !== ""),
      startup: startupFromForm(data),
    };

    // Allow is only ever recorded when the user turns "On" here; an inherited value is asked for at connect.
    const turnedOn = forwardAgent === true && host?.forwardAgent !== true;
    const inheritedLoaded = !!inherited || !data.groupId;
    const turnedOff =
      (forwardAgent === false && host?.forwardAgent !== false) ||
      (forwardAgent === null &&
        host?.forwardAgent === true &&
        inheritedLoaded &&
        !inherited?.forwardAgent);
    if (host) {
      if (!(await updateHost(host.id, hostData))) {
        toast.error(useHostStore.getState().error ?? "Couldn't save host");
        return;
      }
      if (turnedOn) await recordAgentForwarding(host.id, true);
      else if (turnedOff) await recordAgentForwarding(host.id, null);
    } else {
      const created = await createHost(hostData);
      if (!created) {
        toast.error(useHostStore.getState().error ?? "Couldn't save host");
        return;
      }
      if (turnedOn) await recordAgentForwarding(created.id, true);
    }
    reset();
    onClose();
  };

  const onSubmit = async (data: HostFormValues) => {
    startTransition(async () => {
      await handleHostSubmit(data);
    });
  };

  const envArray = useEnvArray(control);
  const formId = useId();
  const summaries = useCardSummaries(control, inherited);
  return (
    <SidePanel
      title={host ? `Edit host · ${host.name}` : "New host"}
      open
      dirty={isDirty}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={async () => {
              if (await useUnsavedChanges.getState().confirmLeave()) onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={isPending}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit(onSubmit)}>
        <div className="space-y-3 p-4">
          <SidePanel.Card icon={<GlobeIcon />} title="Address">
            <FormInput
              name="name"
              label="Name"
              control={control}
              placeholder="My Server"
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
                  placeholder={portLine(inherited)}
                />
              </div>
            </div>
          </SidePanel.Card>
          <SidePanel.Card icon={<SlidersHorizontalIcon />} title="General">
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

            <fieldset>
              <legend className="mb-2 block text-sm font-medium leading-none text-dark-300">
                Color
              </legend>
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
                            ? "ring-2 ring-white ring-offset-2 ring-offset-dark-800"
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
          </SidePanel.Card>
          <SidePanel.Card
            icon={<KeyIcon />}
            title="Credentials"
            summary={summaries.credentials}
          >
            {!usesIdentity && (
              <div>
                <FormInput
                  name="username"
                  label="Username"
                  control={control}
                  placeholder={inherited?.username ?? "Ask when connecting"}
                />
                {inherited?.username && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-dark-400">
                    <span>
                      {watch("username") ? "Overrides" : "From group"}
                    </span>
                    <Badge className="max-w-32">
                      <span className="truncate">{inherited.usernameFrom}</span>
                    </Badge>
                    {watch("username") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Use group value"
                        onClick={() => {
                          setValue("username", "", { shouldDirty: true });
                          // The button hides once the field is empty; keep focus in the panel.
                          setFocus("username");
                        }}
                      >
                        <ArrowCounterClockwiseIcon />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            <CredentialsFields
              control={control}
              mode="host"
              inherited={inherited}
              resetField={resetField}
            />
          </SidePanel.Card>
          <SidePanel.Card
            icon={<ArrowsLeftRightIcon />}
            title="Connection"
            summary={summaries.connection}
          >
            <div>
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
              <p className="mt-1 text-xs text-dark-500">
                The bastion uses its own SSH credentials and host-key check
                before connecting to this host.
              </p>
              {(missingBastion || routeError) && (
                <p role="alert" className="mt-1 text-xs text-red-400">
                  {routeError ??
                    "Selected bastion is unavailable. Choose another route before saving."}
                </p>
              )}
            </div>

            <ConnectionOptionsFields
              control={control}
              mode="host"
              inherited={inherited}
              part="connection"
            />
          </SidePanel.Card>
          <SidePanel.Card
            icon={<PlayIcon />}
            title="On connect"
            summary={summaries.startup}
          >
            <ConnectionOptionsFields
              control={control}
              mode="host"
              inherited={inherited}
              part="startup"
            />
          </SidePanel.Card>
          <SidePanel.Card
            icon={<TerminalWindowIcon />}
            title="Environment"
            action={<EnvAddButton envArray={envArray} />}
            summary={summaries.env}
          >
            <ConnectionOptionsFields
              control={control}
              mode="host"
              inherited={inherited}
              part="env"
              envArray={envArray}
            />
          </SidePanel.Card>
        </div>
      </form>
    </SidePanel>
  );
}
