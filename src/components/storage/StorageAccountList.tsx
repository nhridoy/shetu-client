import { CloudIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import StorageAccountModal from "@/components/storage/StorageAccountModal";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  type StorageAccount,
  useStorageAccountStore,
} from "@/stores/storage/storageAccountStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

/** S3-compatible bucket accounts, opened from a file pane's "Connect Bucket". */
export default function StorageAccountList() {
  const accounts = useStorageAccountStore((s) => s.accounts);
  const error = useStorageAccountStore((s) => s.error);
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const [editing, setEditing] = useState<StorageAccount | "new" | null>(null);
  const [deleting, setDeleting] = useState<StorageAccount | null>(null);

  useEffect(() => {
    void useStorageAccountStore
      .getState()
      .fetchStorageAccounts(currentVaultId ?? undefined);
  }, [currentVaultId]);

  return (
    <div>
      <SectionHeader
        title="Storage"
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
          New storage account
        </Button>
      </SectionHeader>

      {error && (
        <p role="alert" className="mb-3 text-xs text-red-400">
          {error}
        </p>
      )}
      {accounts.length === 0 ? (
        <EmptyState
          icon={CloudIcon}
          title="No storage accounts"
          description="Add an S3, R2, B2, Wasabi, Spaces or MinIO bucket to browse it in a file pane"
        />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="relative rounded-lg border border-primary-500/10 bg-dark-800/50 hover:bg-dark-800 group"
            >
              <button
                type="button"
                onClick={() => setEditing(account)}
                className="w-full p-3 text-left"
              >
                <span className="block text-sm font-medium text-white truncate">
                  {account.name}
                </span>
              </button>
              <Button
                type="button"
                onClick={() => setDeleting(account)}
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500"
                title="Delete storage account"
              >
                <TrashIcon className="w-3 h-3" weight="bold" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <StorageAccountModal
          account={editing}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDeleteDialog
        open={deleting !== null}
        message={`Delete storage account '${deleting?.name ?? ""}'? Files in the bucket are not touched.`}
        onConfirm={() => {
          const id = deleting?.id;
          setDeleting(null);
          if (id) void useStorageAccountStore.getState().remove(id);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
