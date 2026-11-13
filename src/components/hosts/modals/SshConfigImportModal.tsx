import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import {
  type ImportSummary,
  planSshImport,
  runSshImport,
  type SshConfigPreview,
} from "@/lib/sshImport/sshImport";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore, VAULT_KIND_TEAM } from "@/stores/vault/vaultStore";

export default function SshConfigImportModal({
  groupId,
  onClose,
}: {
  groupId: string | null;
  onClose: () => void;
}) {
  const { hosts, createHost } = useHostStore();
  const { keys, importKey, fetchKeys } = useKeyStore();
  const { vaults, currentVaultId } = useVaultStore();
  const vault = vaults.find((v) => v.id === currentVaultId);
  const [keysReady, setKeysReady] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SshConfigPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [passphrases, setPassphrases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<ImportSummary["problems"] | null>(
    null,
  );

  // Keys may be unfetched or from another vault; wait for this vault's keys before importing.
  useEffect(() => {
    let cancelled = false;
    setKeysReady(false);
    setKeysError(null);
    fetchKeys(currentVaultId ?? undefined)
      .then((ok) => {
        if (cancelled) return;
        if (ok) setKeysReady(true);
        else setKeysError("Couldn't load your keys for this vault.");
      })
      .catch((e) => {
        if (!cancelled) setError(extractError(e, "Failed to load keys"));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchKeys, currentVaultId]);

  useEffect(() => {
    invoke<SshConfigPreview>("ssh_config_preview")
      .then(setPreview)
      .catch((e) => setError(extractError(e, "Failed to read ~/.ssh/config")));
  }, []);

  const rows = useMemo(
    () =>
      preview
        ? planSshImport(
            preview,
            hosts.map((h) => h.name),
          )
        : [],
    [preview, hosts],
  );
  const selected = rows.filter((r) => !r.existing && !unchecked.has(r.alias));
  const vaultFingerprints = new Set(keys.map((k) => k.fingerprint));
  // Keys already in the vault are reused: no passphrase prompt, not counted.
  const isNewKey = (k: { fingerprint: string | null }) =>
    !(k.fingerprint && vaultFingerprints.has(k.fingerprint));
  const encryptedKeys = [
    ...new Map(
      selected.flatMap((r) =>
        r.key?.status === "encrypted" && isNewKey(r.key)
          ? [[r.key.path, r.key] as const]
          : [],
      ),
    ).values(),
  ];
  const keyCount = new Set(
    selected.flatMap((r) =>
      r.key &&
      isNewKey(r.key) &&
      (r.key.status === "ready" ||
        (r.key.status === "encrypted" && passphrases[r.key.path]))
        ? [r.key.path]
        : [],
    ),
  ).size;

  const toggle = (alias: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(alias)) next.add(alias);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const summary = await runSshImport(
        rows.filter((r) => r.existing || selected.includes(r)),
        passphrases,
        {
          groupId,
          existingKeys: keys,
          existingHosts: hosts,
          readKey: (path) => invoke<string>("ssh_config_read_key", { path }),
          importKey,
          createHost: (h) => createHost(h, { probeOs: false }),
          newId: () => crypto.randomUUID(),
        },
      );
      if (summary.hostsImported === 0) toast.error("No hosts were imported");
      else
        toast.success(
          `Imported ${summary.hostsImported} hosts and ${summary.keysImported} keys`,
        );
      if (summary.problems.length) setProblems(summary.problems);
      else onClose();
    } catch (e) {
      setError(`Import stopped: ${extractError(e, "Import failed")}`);
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (problems) {
    body = (
      <ul className="space-y-1 text-sm text-amber-400">
        {problems.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a host can have several problems
          <li key={i}>
            {p.alias}: {p.message}
          </li>
        ))}
      </ul>
    );
  } else if (error && !preview) {
    body = <p className="text-sm text-red-500">{error}</p>;
  } else if (!preview) {
    body = <p className="text-sm text-dark-500">Reading ~/.ssh/config...</p>;
  } else if (rows.length === 0) {
    body = (
      <p className="text-sm text-dark-500">No hosts found in ~/.ssh/config</p>
    );
  } else {
    body = (
      <div className="space-y-4">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {keysError && <p className="text-sm text-red-500">{keysError}</p>}
        {preview.ignoredScopedIncludeFiles.length > 0 && (
          <p className="text-sm text-amber-400">
            Host blocks inside an Include under a Host entry aren't supported
            and were ignored in: {preview.ignoredScopedIncludeFiles.join(", ")}
          </p>
        )}
        {preview.ignoredMatchFiles.length > 0 && (
          <p className="text-sm text-amber-400">
            Match blocks aren't supported and were ignored in:{" "}
            {preview.ignoredMatchFiles.join(", ")}
          </p>
        )}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.alias} className="flex items-start gap-3 text-sm">
              <Checkbox
                aria-label={`Import ${r.alias}`}
                checked={!r.existing && !unchecked.has(r.alias)}
                disabled={r.existing || busy}
                onCheckedChange={() => toggle(r.alias)}
              />
              <div className="min-w-0">
                <div className="text-white">
                  {r.alias}
                  {r.existing && (
                    <span className="ml-2 text-dark-500">already in Shetu</span>
                  )}
                </div>
                <div className="text-xs text-dark-500">
                  {r.user ? `${r.user}@` : ""}
                  {r.hostname}:{r.port}
                  {r.key && ` · ${r.key.fileName}`}
                  {r.jumpAlias && ` · via ${r.jumpAlias}`}
                </div>
                {[r.keyNote, r.jumpNote].filter(Boolean).map((n) => (
                  <div key={n} className="text-xs text-amber-400">
                    {n}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
        {encryptedKeys.map((k) => (
          <div key={k.path} className="space-y-1 text-sm text-white">
            <label htmlFor={`pp-${k.path}`}>Passphrase for {k.fileName}</label>
            <Input
              id={`pp-${k.path}`}
              type="password"
              value={passphrases[k.path] ?? ""}
              disabled={busy}
              onChange={(e) =>
                setPassphrases((p) => ({ ...p, [k.path]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Modal
      onClose={onClose}
      title="Import from SSH config"
      maxWidth="max-w-xl"
      hideClose={busy}
    >
      {body}
      {vault?.kind === VAULT_KIND_TEAM && !problems && (
        <p className="mt-4 text-sm text-amber-400">
          This is a team vault. Imported keys will be shared with its members.
        </p>
      )}
      <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-dark-700">
        {problems ? (
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={busy || !keysReady || selected.length === 0}
            >
              Import {selected.length} hosts and {keyCount} keys
              {vault ? ` into ${vault.name}` : ""}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
