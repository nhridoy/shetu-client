import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { useSharedVaultStore } from "@/stores/teams/sharedVaultStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface SharedVaultManagerProps {
  teamId: string;
  canManage: boolean;
}

export default function SharedVaultManager({
  teamId,
  canManage,
}: SharedVaultManagerProps) {
  const {
    sharedVaults,
    isLoading,
    error,
    fetchSharedVaults,
    createSharedVault,
    renameSharedVault,
    deleteSharedVault,
    rotateSharedVault,
  } = useSharedVaultStore();
  const [name, setName] = useState("");
  const pendingVaultId = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  useEffect(() => {
    pendingVaultId.current = null;
    void fetchSharedVaults(teamId);
  }, [teamId, fetchSharedVaults]);

  const create = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError("Enter a vault name.");
      return;
    }
    try {
      pendingVaultId.current ??= crypto.randomUUID();
      await createSharedVault(teamId, pendingVaultId.current, name.trim());
      pendingVaultId.current = null;
      setName("");
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Could not create the shared vault.",
      );
    }
  };

  const remove = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    try {
      await deleteSharedVault(teamId, id);
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the shared vault.",
      );
    }
  };

  const rename = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameId || !renameName.trim()) {
      setFormError("Enter a vault name.");
      return;
    }
    setFormError(null);
    try {
      await renameSharedVault(teamId, renameId, renameName.trim());
      setRenameId(null);
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Could not rename the shared vault.",
      );
    }
  };

  return (
    <section className="mt-6 space-y-4" aria-label="Shared vaults">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-white font-medium">Shared vaults</h4>
          <p className="text-sm text-dark-300">
            Members can use saved connections here, even while offline after the
            vault is cached.
          </p>
        </div>
      </div>
      {canManage && (
        <form className="flex items-center gap-2" onSubmit={create}>
          <label className="sr-only" htmlFor="new-shared-vault-name">
            New shared vault name
          </label>
          <input
            id="new-shared-vault-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder="New shared vault name"
            className="min-w-0 flex-1 rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <Button type="submit" size="sm" disabled={isLoading}>
            Create vault
          </Button>
        </form>
      )}
      {(formError || error) && (
        <p role="alert" className="text-sm text-danger-400">
          {formError || error}
        </p>
      )}
      {sharedVaults.length === 0 ? (
        <p className="rounded-lg bg-dark-800 p-4 text-sm text-dark-300">
          {isLoading
            ? "Loading shared vaults..."
            : canManage
              ? "No shared vaults yet. Create one to share saved connections with this team."
              : "This team has no shared vaults yet."}
        </p>
      ) : (
        <div className="divide-y divide-dark-700 rounded-lg bg-dark-800">
          {sharedVaults
            .filter((vault) => vault.teamId === teamId)
            .map((vault) => (
              <div
                key={vault.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  {renameId === vault.id ? (
                    <form onSubmit={rename} className="flex items-center gap-2">
                      <label
                        className="sr-only"
                        htmlFor={`rename-shared-vault-${vault.id}`}
                      >
                        Shared vault name
                      </label>
                      <input
                        id={`rename-shared-vault-${vault.id}`}
                        value={renameName}
                        onChange={(event) => setRenameName(event.target.value)}
                        maxLength={120}
                        className="min-w-0 rounded border border-dark-600 bg-dark-900 px-2 py-1 text-sm text-white"
                      />
                      <Button type="submit" size="sm" disabled={isLoading}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenameId(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <p className="truncate text-sm font-medium text-white">
                      {vault.name}
                    </p>
                  )}
                  {vault.rotationState !== "ready" && (
                    <p className="text-xs text-amber-300">
                      Key rotation required before new changes can sync.
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {canManage && renameId !== vault.id && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => {
                        setRenameId(vault.id);
                        setRenameName(vault.name);
                      }}
                    >
                      Rename
                    </Button>
                  )}
                  {canManage && vault.rotationState === "rotation_required" && (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => void rotateSharedVault(teamId, vault.id)}
                    >
                      Rotate keys
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void useVaultStore.getState().switchVault(vault.id)
                    }
                  >
                    Open
                  </Button>
                  {canManage && (
                    <Button
                      type="button"
                      variant="soft-destructive"
                      size="sm"
                      onClick={() => setDeleteId(vault.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
      <ConfirmDeleteDialog
        open={deleteId !== null}
        message="Delete this shared vault for all team members? Offline copies may remain on their devices."
        onConfirm={() => void remove()}
        onCancel={() => setDeleteId(null)}
      />
    </section>
  );
}
