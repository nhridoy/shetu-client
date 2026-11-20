import { CloudIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Link } from "react-router";
import {
  type StorageAccount,
  useStorageAccountStore,
} from "@/stores/storage/storageAccountStore";

/** Picks a saved S3 account to open in a pane. */
export default function StorageAccountPicker({
  onConnect,
  onClose,
}: {
  onConnect: (account: StorageAccount) => void;
  onClose: () => void;
}) {
  const accounts = useStorageAccountStore((s) => s.accounts);

  useEffect(() => {
    void useStorageAccountStore.getState().fetchStorageAccounts();
  }, []);

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-dark-400">
        No storage accounts yet. Add one under{" "}
        <Link to="/keys" className="text-primary-400" onClick={onClose}>
          Keychain → Storage
        </Link>
        .
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {accounts.map((account) => (
        <li key={account.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-white hover:bg-dark-800"
            onClick={() => {
              onConnect(account);
              onClose();
            }}
          >
            <CloudIcon className="h-4 w-4 text-dark-400" />
            {account.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
