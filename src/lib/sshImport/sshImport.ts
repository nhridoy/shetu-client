import type { Host } from "@/stores/hosts/hostStore";

export type SshConfigKey = {
  path: string;
  fileName: string;
  status: "ready" | "encrypted" | "missing" | "unreadable";
  fingerprint: string | null;
  keyType: string | null;
};

export type SshConfigHost = {
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
  proxyJump: string | null;
  key: SshConfigKey | null;
};

export type SshConfigPreview = {
  hosts: SshConfigHost[];
  ignoredMatchFiles: string[];
};

export type ImportRow = {
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
  key: SshConfigKey | null;
  keyNote?: string;
  jumpAlias: string | null;
  jumpNote?: string;
  existing: boolean;
};

export type ImportDeps = {
  groupId: string | null;
  existingKeys: { id: string; fingerprint?: string }[];
  existingHosts: { id: string; name: string }[];
  readKey(path: string): Promise<string>;
  importKey(k: {
    id: string;
    name: string;
    encryptedPrivateKey: string;
    passphrase?: string;
  }): Promise<void>;
  createHost(h: Partial<Host>): Promise<Host | null>;
  newId(): string;
};

export type ImportSummary = {
  hostsImported: number;
  keysImported: number;
  problems: { alias: string; message: string }[];
};

const CHAIN_NOTE = "Jump chains aren't supported; imported without a jump host";

const KEY_NOTES: Partial<Record<SshConfigKey["status"], string>> = {
  missing: "Key file not found; imported without a key",
  unreadable: "Key file couldn't be read; imported without a key",
};

export function planSshImport(
  preview: SshConfigPreview,
  existingHostNames: string[],
): ImportRow[] {
  const existing = new Set(existingHostNames.map((n) => n.toLowerCase()));
  const byAlias = new Map(preview.hosts.map((h) => [h.alias, h]));

  return preview.hosts.map((h) => {
    const row: ImportRow = {
      alias: h.alias,
      hostname: h.hostname,
      user: h.user,
      port: h.port,
      key: h.key,
      jumpAlias: null,
      existing: existing.has(h.alias.toLowerCase()),
    };
    const keyNote = h.key && KEY_NOTES[h.key.status];
    if (keyNote) row.keyNote = keyNote;

    const jump = h.proxyJump?.trim();
    if (jump) {
      const target = byAlias.get(jump);
      if (jump.includes(",") || target?.proxyJump) row.jumpNote = CHAIN_NOTE;
      else if (target || existing.has(jump.toLowerCase())) row.jumpAlias = jump;
      else row.jumpNote = `Jump host ${jump} isn't in your config or Shetu`;
    }
    return row;
  });
}

export async function runSshImport(
  rows: ImportRow[],
  passphrases: Record<string, string>,
  deps: ImportDeps,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    hostsImported: 0,
    keysImported: 0,
    problems: [],
  };
  const existingHostId = (name: string) =>
    deps.existingHosts.find((e) => e.name.toLowerCase() === name.toLowerCase())
      ?.id;

  // An existing row keeps its Shetu id so it can still be a jump target.
  const ids = new Map<string, string>();
  for (const r of rows)
    ids.set(r.alias, (r.existing && existingHostId(r.alias)) || deps.newId());

  const toCreate = rows.filter((r) => !r.existing);

  // One outcome per distinct key file: a key id, or the reason it was skipped.
  const keys = new Map<string, { keyId?: string; problem?: string }>();
  for (const r of toCreate) {
    const k = r.key;
    if (!k || keys.has(k.path)) continue;
    if (k.status === "missing" || k.status === "unreadable") continue;
    const reused =
      k.fingerprint &&
      deps.existingKeys.find((e) => e.fingerprint === k.fingerprint)?.id;
    if (reused) {
      keys.set(k.path, { keyId: reused });
      continue;
    }
    const passphrase = passphrases[k.path];
    if (k.status === "encrypted" && !passphrase) {
      keys.set(k.path, {
        problem: "No passphrase given; imported without a key",
      });
      continue;
    }
    try {
      const id = deps.newId();
      await deps.importKey({
        id,
        name: k.fileName,
        encryptedPrivateKey: await deps.readKey(k.path),
        passphrase: k.status === "encrypted" ? passphrase : undefined,
      });
      summary.keysImported++;
      keys.set(k.path, { keyId: id });
    } catch (e) {
      keys.set(k.path, { problem: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const r of toCreate) {
    const outcome = r.key ? keys.get(r.key.path) : undefined;
    if (outcome?.problem)
      summary.problems.push({ alias: r.alias, message: outcome.problem });
    const keyId = outcome?.keyId;
    const created = await deps.createHost({
      id: ids.get(r.alias),
      name: r.alias,
      address: r.hostname,
      port: r.port,
      username: r.user ?? "root",
      authType: keyId ? "key" : "password",
      keyId,
      jumpHostId: r.jumpAlias
        ? (ids.get(r.jumpAlias) ?? existingHostId(r.jumpAlias))
        : undefined,
      groupId: deps.groupId,
    });
    if (created) summary.hostsImported++;
    else
      summary.problems.push({
        alias: r.alias,
        message: "Couldn't create host",
      });
  }
  return summary;
}
