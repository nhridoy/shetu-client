import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import {
  type ImportPreview,
  type ImportSummary,
  planImport,
  runImport,
} from "@/lib/import/hostImport";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore, VAULT_KIND_TEAM } from "@/stores/vault/vaultStore";

type SourceId =
  | "ssh_config"
  | "putty"
  | "winscp"
  | "mobaxterm"
  | "securecrt"
  | "tabby"
  | "iterm2"
  | "termius_csv";

const SOURCES: {
  id: SourceId;
  label: string;
  file?: { name: string; extensions: string[] };
}[] = [
  { id: "ssh_config", label: "SSH config" },
  {
    id: "putty",
    label: "PuTTY",
    file: { name: "PuTTY registry export", extensions: ["reg"] },
  },
  {
    id: "winscp",
    label: "WinSCP",
    file: { name: "WinSCP.ini", extensions: ["ini"] },
  },
  {
    id: "mobaxterm",
    label: "MobaXterm",
    file: { name: "MobaXterm sessions", extensions: ["mxtsessions", "ini"] },
  },
  {
    id: "securecrt",
    label: "SecureCRT",
    file: { name: "SecureCRT export", extensions: ["xml"] },
  },
  {
    id: "tabby",
    label: "Tabby",
    file: { name: "Tabby config", extensions: ["yaml", "yml"] },
  },
  {
    id: "iterm2",
    label: "iTerm2",
    file: { name: "iTerm2 profiles", extensions: ["json"] },
  },
  {
    id: "termius_csv",
    label: "Termius (CSV)",
    file: { name: "CSV", extensions: ["csv"] },
  },
];

/** Import hosts from ssh_config or another SSH app; folders become groups. */
export default function ImportModal({
  groupId,
  onClose,
}: {
  groupId: string | null;
  onClose: () => void;
}) {
  const { hosts, groups, createHost, createGroup } = useHostStore();
  const { keys, importKey, fetchKeys } = useKeyStore();
  const { vaults, currentVaultId } = useVaultStore();
  const vault = vaults.find((v) => v.id === currentVaultId);
  const [keysReady, setKeysReady] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [detected, setDetected] = useState<
    { source: string; origin: string }[] | null
  >(null);
  const [chosen, setChosen] = useState<{
    source: SourceId;
    path: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
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
    invoke<{ source: string; origin: string }[]>("import_detect")
      .then(setDetected)
      .catch(() => setDetected([]));
  }, []);

  // Only the latest preview request may set state; Back or another pick makes older ones stale.
  const request = useRef(0);
  const choose = async (source: SourceId, path: string | null) => {
    const mine = ++request.current;
    setChosen({ source, path });
    setPreview(null);
    setError(null);
    setUnchecked(new Set());
    setPassphrases({});
    try {
      const result = await invoke<ImportPreview>("import_preview", {
        source,
        path,
      });
      if (mine === request.current) setPreview(result);
    } catch (e) {
      if (mine === request.current)
        setError(extractError(e, "Couldn't read the sessions"));
    }
  };

  const pickFile = async (source: (typeof SOURCES)[number]) => {
    if (!source.file) return;
    const path = await open({ multiple: false, filters: [source.file] });
    if (typeof path === "string") await choose(source.id, path);
  };

  const back = () => {
    request.current++;
    setChosen(null);
    setPreview(null);
    setError(null);
  };

  const rows = useMemo(
    () =>
      preview
        ? planImport(preview, {
            rootGroupId: groupId,
            groups,
            hosts: hosts.map((h) => ({ name: h.name, groupId: h.groupId })),
          })
        : [],
    [preview, hosts, groups, groupId],
  );
  const selected = rows.filter((r) => !r.existing && !unchecked.has(r.id));
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

  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!chosen) return;
      const summary = await runImport(
        rows.filter((r) => r.existing || selected.includes(r)),
        passphrases,
        {
          groupId,
          source: chosen.source,
          groups,
          existingKeys: keys,
          existingHosts: hosts,
          readKey: (keyPath) =>
            invoke<string>("import_read_key", {
              source: chosen.source,
              path: chosen.path,
              keyPath,
            }),
          convertPpk: (text, passphrase) =>
            invoke<string>("convert_ppk", { text, passphrase }),
          createGroup: (g) => createGroup(g),
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
  } else if (!chosen) {
    body = (
      <ul className="space-y-2">
        {SOURCES.map((source) => {
          const found = detected?.find((d) => d.source === source.id);
          return (
            <li
              key={source.id}
              className="flex items-center gap-3 text-sm text-white"
            >
              <div className="flex-1 min-w-0">
                <div>{source.label}</div>
                <div className="text-xs text-dark-500 truncate">
                  {found
                    ? `Found: ${found.origin}`
                    : source.file
                      ? "Not found here; choose an exported file"
                      : "Not found"}
                </div>
              </div>
              {(found || source.id === "ssh_config") && (
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Import from ${source.label}`}
                  onClick={() => void choose(source.id, null)}
                >
                  Import
                </Button>
              )}
              {source.file && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-label={`Choose ${source.label} file`}
                  onClick={() => void pickFile(source)}
                >
                  Choose file…
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  } else if (error && !preview) {
    body = <p className="text-sm text-red-500">{error}</p>;
  } else if (!preview) {
    body = <p className="text-sm text-dark-500">Reading sessions...</p>;
  } else if (rows.length === 0) {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-dark-500">
          No hosts found in {preview.origin}
        </p>
        <Skipped list={preview.skipped} />
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {keysError && <p className="text-sm text-red-500">{keysError}</p>}
        <Skipped list={preview.skipped} />
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 text-sm">
              <Checkbox
                aria-label={`Import ${r.alias}`}
                checked={!r.existing && !unchecked.has(r.id)}
                disabled={r.existing || busy}
                onCheckedChange={() => toggle(r.id)}
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
                  {r.key && ` · ${r.key.path}`}
                  {r.jumpAlias &&
                    ` · via ${rows.find((x) => x.id === r.jumpAlias)?.alias ?? r.jumpAlias}`}
                </div>
                {r.folder.length > 0 && (
                  <div className="text-xs text-dark-400">
                    Folder: {r.folder.join(" / ")}
                  </div>
                )}
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
      title="Import hosts"
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
            {chosen && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Back"
                onClick={back}
                disabled={busy}
                className="mr-auto"
              >
                Back
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            {chosen && (
              <Button
                type="button"
                size="sm"
                onClick={submit}
                disabled={busy || !keysReady || selected.length === 0}
              >
                Import {selected.length} hosts and {keyCount} keys
                {vault ? ` into ${vault.name}` : ""}
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Skipped({ list }: { list: { name: string; reason: string }[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-amber-400">
      {list.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat
        <li key={i}>
          {s.name}: {s.reason}
        </li>
      ))}
    </ul>
  );
}
