import { invoke } from "@tauri-apps/api/core";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { saveFilePicker } from "@/lib/sftp/localFs";
import { TEAM_ACCESS_REVOKED_EVENT } from "@/stores/sync/syncStore";

interface RevokedVaultEdits {
  vault_id: string;
  name: string;
  pending: number;
}

interface ExportedEdit {
  table: string;
  id: string;
  name: string | null;
  deleted_at: string | null;
  plaintext: string;
}

export default function RevokedTeamEditsPanel() {
  const [vaults, setVaults] = useState<RevokedVaultEdits[]>([]);
  const [busy, setBusy] = useState(false);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setVaults(await invoke<RevokedVaultEdits[]>("list_revoked_team_edits"));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(TEAM_ACCESS_REVOKED_EVENT, refresh);
    return () => window.removeEventListener(TEAM_ACCESS_REVOKED_EVENT, refresh);
  }, [refresh]);

  const exportEdits = async (vault: RevokedVaultEdits) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = await saveFilePicker(
        `terra-unsynced-team-edits-${vault.vault_id}.json`,
      );
      if (!path) return;
      const edits = await invoke<ExportedEdit[]>("export_revoked_team_edits", {
        vaultId: vault.vault_id,
      });
      const content = JSON.stringify(
        {
          format: "termvault-revoked-team-edits-v1",
          vault_id: vault.vault_id,
          exported_at: new Date().toISOString(),
          edits,
        },
        null,
        2,
      );
      await writeTextFile(path, content);
      setNotice(`Exported ${edits.length} edits to ${path}.`);
    } catch (cause) {
      setError(`Could not export edits: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const discardEdits = async () => {
    const vaultId = discardId;
    setDiscardId(null);
    if (!vaultId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("discard_revoked_team_edits", { vaultId });
      await refresh();
      setNotice(
        "Pending sync operations discarded. Encrypted local rows remain on this device.",
      );
    } catch (cause) {
      setError(`Could not discard pending operations: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  if (vaults.length === 0 && !error && !notice) return null;
  return (
    <section
      className="border-b border-dark-700 px-4 py-3 space-y-2"
      aria-label="Unsynced team edits"
    >
      <h3 className="text-sm font-medium text-amber-300">
        Unsynced team edits
      </h3>
      <p className="text-xs text-dark-300">
        The server denied access to these shared vaults. Their queued edits
        remain encrypted on this device and will not sync. Export creates a
        plaintext file containing secrets; store it securely.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger-400">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {vaults.map((vault) => (
        <div
          key={vault.vault_id}
          className="flex items-center justify-between gap-2 text-sm text-dark-200"
        >
          <span>
            {vault.name} · {vault.pending} pending{" "}
            {vault.pending === 1 ? "edit" : "edits"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void exportEdits(vault)}
            >
              Export edits
            </Button>
            <Button
              type="button"
              variant="soft-destructive"
              size="sm"
              disabled={busy}
              onClick={() => setDiscardId(vault.vault_id)}
            >
              Discard queue
            </Button>
          </div>
        </div>
      ))}
      <ConfirmDeleteDialog
        open={discardId !== null}
        message="Discard these pending sync operations? The encrypted local rows remain on this device, but the edits will no longer be queued for sync. Export first if you need a portable copy."
        onConfirm={() => void discardEdits()}
        onCancel={() => setDiscardId(null)}
      />
    </section>
  );
}
