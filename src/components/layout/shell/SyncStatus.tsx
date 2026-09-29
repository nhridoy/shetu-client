import { useNavigate } from "react-router";
import { useSyncStore } from "@/stores/sync/syncStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

const LABELS = {
  "local-only": "Local only",
  pending: "Pending",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  "auth-required": "Sign in to sync",
  error: "Sync error",
} as const;

export default function SyncStatus() {
  const navigate = useNavigate();
  const vaultId = useVaultStore((state) => state.currentVaultId);
  const state = useSyncStore((sync) => sync.state);
  const pendingCount = useSyncStore((sync) => sync.pendingCount);
  const lastSyncAt = useSyncStore((sync) => sync.lastSyncAt);
  const error = useSyncStore((sync) => sync.error);
  const retry = useSyncStore((sync) => sync.retry);

  if (!vaultId) return null;
  const pending = pendingCount > 0 ? ` (${pendingCount})` : "";
  const title =
    error ?? (lastSyncAt ? `Last synced ${lastSyncAt}` : "Sync saved data");
  return (
    <button
      type="button"
      aria-label={`Sync status: ${LABELS[state]}${pending}. Sync now`}
      aria-live="polite"
      title={title}
      onClick={() => {
        if (state === "auth-required")
          navigate("/login", { state: { reauth: true } });
        else void retry(vaultId);
      }}
      className="rounded px-2 py-1 text-xs text-dark-300 hover:bg-dark-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
    >
      {LABELS[state]}
      {pending}
    </button>
  );
}
