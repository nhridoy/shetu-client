import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowsLeftRightIcon,
  KeyIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import SidePanel from "@/components/common/SidePanel";
import { Button } from "@/components/ui/Button";
import { FormInput } from "@/components/ui/forms/FormInput";
import {
  type GroupFormValues,
  groupFormDefaultValues,
  groupFormSchema,
} from "@/lib/schema/hosts/groupFormSchema";
import { isBlank } from "@/lib/schema/hosts/hostFormSchema";
import {
  type Group as StoredGroup,
  useHostStore,
} from "@/stores/hosts/hostStore";
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

interface Group {
  id: string;
  name: string;
  parentId?: string;
  vaultId?: string;
  sortOrder: number;
  createdAt: string;
}

interface GroupFormProps {
  group?: Group;
  defaultParentId?: string;
  onClose: () => void;
}

function valuesFromGroup(g: StoredGroup): GroupFormValues {
  const startup = g.startup;
  return {
    name: g.name,
    username: g.username ?? "",
    authType: g.authType ?? "",
    identityId: g.identityId ?? "",
    password: g.password ?? "",
    keyId: g.keyId ?? "",
    port: g.port ?? "",
    keepaliveSecs: g.keepaliveSecs ?? "",
    forwardAgent:
      g.forwardAgent == null ? "unset" : g.forwardAgent ? "on" : "off",
    env: g.env ?? [],
    startupMode:
      startup && "snippetId" in startup
        ? "snippet"
        : startup && "command" in startup
          ? "command"
          : "none",
    startupSnippetId:
      startup && "snippetId" in startup ? startup.snippetId : "",
    startupCommand: startup && "command" in startup ? startup.command : "",
  };
}

/** Payload for the store; `unset` is null on update (clears the field) and undefined on create (omits it). */
function payloadFromForm(
  d: GroupFormValues,
  unset: null | undefined,
): Partial<StoredGroup> {
  const auth = d.authType || null;
  const usesPassword = auth === "password" || auth === "both";
  const usesKey = auth === "key" || auth === "both";
  const env = d.env.filter((row) => row.name !== "");
  const command = d.startupCommand?.trim();
  return {
    username: d.username?.trim() || unset,
    authType: auth ?? unset,
    identityId: (auth === "identity" && d.identityId) || unset,
    password: (usesPassword && d.password) || unset,
    keyId: (usesKey && d.keyId) || unset,
    port: isBlank(d.port) ? unset : Number(d.port),
    keepaliveSecs: isBlank(d.keepaliveSecs) ? unset : Number(d.keepaliveSecs),
    forwardAgent:
      d.forwardAgent === "on" ? true : d.forwardAgent === "off" ? false : unset,
    env: env.length || unset === null ? env : undefined,
    startup:
      d.startupMode === "snippet" && d.startupSnippetId
        ? { snippetId: d.startupSnippetId }
        : d.startupMode === "command" && command
          ? { command }
          : unset,
  };
}

export default function GroupForm({
  group,
  defaultParentId,
  onClose,
}: GroupFormProps) {
  const { createGroup, updateGroup } = useHostStore();
  const { currentVaultId } = useVaultStore();
  const [isPending, startTransition] = useTransition();

  const currentVault = currentVaultId ?? undefined;
  const fetchKeys = useKeyStore((s) => s.fetchKeys);
  const fetchSnippets = useSnippetStore((s) => s.fetchSnippets);

  const {
    control,
    handleSubmit,
    reset,
    resetField,
    formState: { isDirty },
  } = useForm<GroupFormValues>({
    resolver: zodResolver(groupFormSchema),
    defaultValues: {
      ...groupFormDefaultValues,
      name: group?.name || groupFormDefaultValues.name,
    },
  });

  useEffect(() => {
    fetchKeys(currentVault);
    fetchSnippets(currentVault);
  }, [fetchKeys, fetchSnippets, currentVault]);

  // Editing must not save until the stored values are in the form, or the
  // blank defaults would overwrite them.
  const groupId = group?.id;
  const [load, setLoad] = useState<"loading" | "ready" | "failed">(
    groupId ? "loading" : "ready",
  );
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setLoad("loading");
    void useHostStore
      .getState()
      .getDecryptedGroup(groupId)
      .then((g) => {
        if (cancelled) return;
        if (!g) return setLoad("failed");
        // Keep a name the user already typed while this was loading.
        reset(valuesFromGroup(g), { keepDirtyValues: true });
        setLoad("ready");
      })
      .catch(() => {
        if (!cancelled) setLoad("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, reset]);

  const handleGroupSubmit = async (data: GroupFormValues) => {
    const parentId = group?.parentId || defaultParentId || undefined;
    if (group) {
      if (load === "loading") return;
      await updateGroup(group.id, {
        // Unreadable stored values: send no credential/option keys so they're kept.
        ...(load === "ready" && payloadFromForm(data, null)),
        name: data.name,
        parentId,
      });
    } else {
      await createGroup({
        ...payloadFromForm(data, undefined),
        name: data.name,
        parentId,
        vaultId: currentVaultId || undefined,
      });
    }
    reset();
    onClose();
  };

  const onSubmit = async (data: GroupFormValues) => {
    startTransition(async () => {
      await handleGroupSubmit(data);
    });
  };

  const envArray = useEnvArray(control);
  const formId = useId();
  const summaries = useCardSummaries(control);
  const busy = isPending || load === "loading";
  return (
    <SidePanel
      title={group ? `Edit group · ${group.name}` : "New group"}
      intro="Hosts in this group use these unless they set their own."
      open
      dirty={isDirty}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (await useUnsavedChanges.getState().confirmLeave()) onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={busy}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit(onSubmit)}>
        <div className="space-y-3 p-4">
          {load === "failed" && (
            <p
              role="alert"
              className="rounded-lg border border-red-500/50 bg-red-500/20 p-3 text-xs text-red-400"
            >
              Couldn't load this group's saved credentials and options. You can
              still rename it; they will be left unchanged.
            </p>
          )}
          <SidePanel.Card icon={<SlidersHorizontalIcon />} title="General">
            <FormInput
              name="name"
              label="Group Name"
              control={control}
              placeholder="Group name"
              required
            />
          </SidePanel.Card>
          {/* Unread values are never saved, so they must not look editable. */}
          <fieldset disabled={load === "failed"} className="min-w-0 space-y-3">
            <SidePanel.Card icon={<KeyIcon />} title="Credentials">
              <FormInput
                name="username"
                label="Username"
                control={control}
                placeholder="Not set"
              />
              <CredentialsFields
                control={control}
                mode="group"
                resetField={resetField}
              />
            </SidePanel.Card>
            <SidePanel.Card icon={<ArrowsLeftRightIcon />} title="Connection">
              <ConnectionOptionsFields
                control={control}
                mode="group"
                part="connection"
              />
            </SidePanel.Card>
            <SidePanel.Card icon={<PlayIcon />} title="On connect">
              <ConnectionOptionsFields
                control={control}
                mode="group"
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
                mode="group"
                part="env"
                envArray={envArray}
              />
            </SidePanel.Card>
          </fieldset>
        </div>
      </form>
    </SidePanel>
  );
}
