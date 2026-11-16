import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import { useVaultStore } from "@/stores/vault/vaultStore";

const FORMATS = [
  {
    id: "ssh_config",
    label: "SSH config",
    file: "shetu-hosts.conf",
    filter: { name: "SSH config", extensions: ["conf", "config"] },
  },
  {
    id: "csv",
    label: "CSV",
    file: "shetu-hosts.csv",
    filter: { name: "CSV", extensions: ["csv"] },
  },
] as const;

/** Exports the open group (with subgroups), or every host, without any secrets. */
export default function ExportModal({
  groupId,
  onClose,
}: {
  groupId: string | null;
  onClose: () => void;
}) {
  const vaultId = useVaultStore((s) => s.currentVaultId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (format: (typeof FORMATS)[number]) => {
    setBusy(true);
    setError(null);
    try {
      const text = await invoke<string>("export_hosts", {
        vaultId,
        groupId,
        format: format.id,
      });
      const path = await save({
        defaultPath: format.file,
        filters: [
          { ...format.filter, extensions: [...format.filter.extensions] },
        ],
      });
      if (!path) return;
      await writeTextFile(path, text);
      toast.success(`Exported to ${path.split(/[\\/]/).pop()}`);
      onClose();
    } catch (e) {
      setError(extractError(e, "Export failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Export hosts" maxWidth="max-w-md">
      <p className="text-sm text-dark-400">
        {groupId
          ? "Exports this group and its subgroups."
          : "Exports every host in this vault."}{" "}
        Passwords and keys are never included.
      </p>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-dark-700">
        {FORMATS.map((f) => (
          <Button
            key={f.id}
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !vaultId}
            onClick={() => void run(f)}
          >
            {f.label}
          </Button>
        ))}
      </div>
    </Modal>
  );
}
