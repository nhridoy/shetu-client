import {
  IdentificationCardIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import IdentityModal from "@/components/identities/IdentityModal";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  type Identity,
  useIdentityStore,
} from "@/stores/identities/identityStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Delete warning for an identity in use; empty when nothing uses it. */
export function usageMessage(hosts: number, groups: number): string {
  const parts = [
    hosts && plural(hosts, "host"),
    groups && plural(groups, "group"),
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return `Used by ${parts.join(" and ")}. They'll ask for a login when connecting.`;
}

export default function IdentityList() {
  const identities = useIdentityStore((s) => s.identities);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Identity | "new" | null>(null);
  const [deleting, setDeleting] = useState<{
    identity: Identity;
    message: string;
  } | null>(null);

  useEffect(() => {
    void useIdentityStore
      .getState()
      .fetchIdentities(currentVaultId ?? undefined);
  }, [currentVaultId]);

  useEffect(() => {
    let live = true;
    void Promise.all(
      identities.map(async (i) => {
        const view = await useIdentityStore
          .getState()
          .getDecryptedIdentity(i.id)
          .catch(() => null);
        return [i.id, view?.username ?? ""] as const;
      }),
    ).then((pairs) => live && setUsernames(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [identities]);

  const askDelete = async (identity: Identity) => {
    const usage = await invoke<{ hosts: number; groups: number }>(
      "identity_usage",
      { identityId: identity.id, vaultId: identity.vaultId },
    ).catch(() => ({ hosts: 0, groups: 0 }));
    const warning = usageMessage(usage.hosts, usage.groups);
    setDeleting({
      identity,
      message: `Delete identity '${identity.name}'?${warning ? ` ${warning}` : ""}`,
    });
  };

  return (
    <div>
      <SectionHeader
        title="Identities"
        level="h3"
        className="text-sm tracking-wider uppercase text-dark-400 mb-3"
      >
        <Button
          type="button"
          onClick={() => setEditing("new")}
          variant="secondary"
          size="sm"
        >
          <PlusIcon className="w-3 h-3" weight="bold" />
          New identity
        </Button>
      </SectionHeader>

      {identities.length === 0 ? (
        <EmptyState
          icon={IdentificationCardIcon}
          title="No identities"
          description="Save a login once and pick it on many hosts"
        />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {identities.map((identity) => (
            <div
              key={identity.id}
              className="relative rounded-lg border border-primary-500/10 bg-dark-800/50 hover:bg-dark-800 group"
            >
              <button
                type="button"
                onClick={() => setEditing(identity)}
                className="w-full p-3 text-left"
              >
                <span className="block text-sm font-medium text-white truncate">
                  {identity.name}
                </span>
                <span className="block mt-1 text-xs truncate text-dark-500">
                  {usernames[identity.id] ?? ""}
                </span>
              </button>
              <Button
                type="button"
                onClick={() => void askDelete(identity)}
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500"
                title="Delete identity"
              >
                <TrashIcon className="w-3 h-3" weight="bold" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <IdentityModal
          identity={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {}}
        />
      )}

      <ConfirmDeleteDialog
        open={deleting !== null}
        message={deleting?.message ?? ""}
        onConfirm={() => {
          const id = deleting?.identity.id;
          setDeleting(null);
          if (id) void useIdentityStore.getState().deleteIdentity(id);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
