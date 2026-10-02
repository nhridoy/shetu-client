import { LockIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useVaultStore } from "@/stores/vault/vaultStore";

export default function VaultList() {
  const { vaults, currentVaultId, switchVault } = useVaultStore();

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-dark-700">
        <h2 className="text-lg font-semibold text-white">Vaults</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {vaults.length === 0 ? (
          <EmptyState
            icon={LockIcon}
            title="No vaults yet"
            description="Create a vault to store credentials"
          />
        ) : (
          vaults.map((vault) => (
            <Button
              key={vault.id}
              variant="secondary"
              onClick={() => switchVault(vault.id)}
              className={`p-3 h-auto rounded-lg mb-2 text-left w-full ${
                currentVaultId === vault.id
                  ? "bg-primary-600/20 border border-primary-500/50"
                  : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-primary-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-white truncate">
                    {vault.name}
                  </p>
                  {vault.description && (
                    <p className="text-sm text-dark-400 truncate">
                      {vault.description}
                    </p>
                  )}
                </div>
                {vault.isDefault && <Badge variant="primary">Default</Badge>}
                {vault.isShared && <Badge variant="primary">Shared</Badge>}
                {vault.accessState === "revoked" && (
                  <span className="text-xs text-danger-400">Access denied</span>
                )}
                {vault.accessState === "rotation_required" && (
                  <span className="text-xs text-amber-300">Rotate keys</span>
                )}
                {vault.isSystem && (
                  <span className="px-2 py-0.5 text-xs bg-dark-600 text-dark-300 rounded flex items-center gap-1">
                    <LockIcon className="w-3 h-3" weight="bold" />
                    Protected
                  </span>
                )}
              </div>
            </Button>
          ))
        )}
      </div>
    </div>
  );
}
