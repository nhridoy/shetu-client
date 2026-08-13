import { KeyIcon, PlusIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import GenerateKeyModal from "@/components/keys/modals/GenerateKeyModal";
import ImportKeyModal from "@/components/keys/modals/ImportKeyModal";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import type { KeyItem } from "@/types/keys/types";

export default function KeyList({ onMutation }: { onMutation?: () => void }) {
  const keys = useKeyStore((s) => s.keys);
  const fetchKeys = useKeyStore((s) => s.fetchKeys);
  const deleteKey = useKeyStore((s) => s.deleteKey);
  const [selectedKey, setSelectedKey] = useState<KeyItem | null>(null);
  const { currentVaultId } = useVaultStore();
  const deleteDialog = useModal();
  const importModal = useModal();
  const generateModal = useModal();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const loadKeys = useCallback(() => {
    fetchKeys(currentVaultId ?? undefined);
  }, [fetchKeys, currentVaultId]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleDelete = (id: string) => {
    setDeleteTargetId(id);
    deleteDialog.show();
  };

  const confirmDeleteAction = async () => {
    deleteDialog.hide();
    const id = deleteTargetId;
    setDeleteTargetId(null);
    if (!id) return;
    await deleteKey(id);
    if (selectedKey?.id === id) setSelectedKey(null);
    onMutation?.();
  };

  const getKeyTypeIcon = (keyType: string) => {
    switch (keyType) {
      case "ed25519":
        return "\u{1F510}";
      case "rsa":
        return "\u{1F511}";
      case "ecdsa":
        return "\u{1F5DD}\uFE0F";
      default:
        return "\u{1F511}";
    }
  };

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <SectionHeader
        title="Keychain"
        level="h3"
        className="text-sm tracking-wider uppercase text-dark-400 mb-3"
      >
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={importModal.show}
            variant="secondary"
            size="sm"
          >
            <PlusIcon className="w-3 h-3" weight="bold" />
            Import
          </Button>
          <Button
            type="button"
            onClick={generateModal.show}
            variant="secondary"
            size="sm"
          >
            <PlusIcon className="w-3 h-3" weight="bold" />
            Generate
          </Button>
        </div>
      </SectionHeader>

      <div className="flex-1 p-4 overflow-y-auto">
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyIcon}
            title="No SSH keys"
            description="Import or generate a key"
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {keys.map((key) => (
              // biome-ignore lint/a11y/useSemanticElements: contains nested <button> for delete
              <div
                key={key.id}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedKey(selectedKey?.id === key.id ? null : key)
                }
                onKeyDown={accessibleClickHandler(() =>
                  setSelectedKey(selectedKey?.id === key.id ? null : key),
                )}
                className={`rounded-lg p-3 cursor-pointer transition-colors group relative ${
                  selectedKey?.id === key.id
                    ? "bg-primary-600/20 border border-primary-500/50"
                    : "bg-dark-800/50 hover:bg-dark-800 border border-primary-500/10"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg shrink-0">
                    {getKeyTypeIcon(key.keyType)}
                  </span>
                  <span className="text-sm font-medium text-white truncate">
                    {key.name}
                  </span>
                </div>
                <p className="mt-1 text-xs truncate text-dark-500 ml-7">
                  {key.keyType.toUpperCase()} •{" "}
                  {key.fingerprint || "No fingerprint"}
                </p>
                <div className="absolute flex items-center gap-1 transition-opacity opacity-0 top-2 right-2 group-hover:opacity-100">
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(key.id);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-red-500"
                    title="Delete key"
                  >
                    <TrashIcon className="w-3 h-3" weight="bold" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedKey && (
        <div className="p-4 border-t border-dark-700 bg-dark-800">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-medium text-white">
              {selectedKey.name} — Public Key
            </h3>
            <Button
              type="button"
              onClick={() => setSelectedKey(null)}
              variant="ghost"
              size="icon-sm"
            >
              <XIcon className="w-4 h-4" weight="bold" />
            </Button>
          </div>
          <pre className="p-3 overflow-y-auto text-sm break-all whitespace-pre-wrap rounded-lg bg-dark-900 text-dark-300 max-h-32">
            {selectedKey.publicKey}
          </pre>
          <Button
            type="button"
            onClick={() => navigator.clipboard.writeText(selectedKey.publicKey)}
            variant="ghost"
            className="mt-2"
          >
            Copy to clipboard
          </Button>
        </div>
      )}

      {importModal.open && (
        <ImportKeyModal
          onClose={importModal.hide}
          onImport={async (key) => {
            await useKeyStore.getState().importKey({
              name: key.name,
              description: key.description,
              keyType: "ed25519",
              publicKey: key.publicKey || "",
              encryptedPrivateKey: key.encryptedPrivateKey || "",
              fingerprint: key.fingerprint || "",
            });
            importModal.hide();
            onMutation?.();
          }}
        />
      )}

      {generateModal.open && (
        <GenerateKeyModal
          vaultId={currentVaultId || undefined}
          onClose={(savedKey?: KeyItem) => {
            if (savedKey) {
              loadKeys();
              onMutation?.();
            }
            generateModal.hide();
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message="Are you sure you want to delete this key?"
        onConfirm={confirmDeleteAction}
        onCancel={() => {
          deleteDialog.hide();
          setDeleteTargetId(null);
        }}
      />
    </div>
  );
}
