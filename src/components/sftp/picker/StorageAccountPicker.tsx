import { CloudIcon, HardDrivesIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
  // Kinds live in each account's encrypted data: read them for the icons.
  const [kinds, setKinds] = useState<Record<string, "s3" | "webdav" | "ftp">>(
    {},
  );

  useEffect(() => {
    void useStorageAccountStore.getState().fetchStorageAccounts();
  }, []);

  useEffect(() => {
    let live = true;
    const store = useStorageAccountStore.getState();
    void Promise.all(
      accounts.map(async (a) => {
        const v = await store.view(a.id).catch(() => null);
        const p = v?.provider;
        return [a.id, p === "webdav" || p === "ftp" ? p : "s3"] as const;
      }),
    ).then((pairs) => {
      if (live) setKinds(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [accounts]);

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
            {kinds[account.id] && kinds[account.id] !== "s3" ? (
              <HardDrivesIcon
                data-kind={kinds[account.id]}
                className="h-4 w-4 text-dark-400"
              />
            ) : (
              <CloudIcon data-kind="s3" className="h-4 w-4 text-dark-400" />
            )}
            {account.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
