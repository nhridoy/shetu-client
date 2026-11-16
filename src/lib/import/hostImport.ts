import type { Host } from "@/stores/hosts/hostStore";

/** A key file a session points at (Rust `ImportKey`). */
export type ImportKey = {
  path: string;
  fileName: string;
  status: "ready" | "encrypted" | "missing" | "unreadable";
  fingerprint: string | null;
  keyType: string | null;
};

/** One session from another app (Rust `ImportedHost`). */
export type ImportedHost = {
  /** The source's own id; `jump` refers to it. */
  id: string;
  name: string;
  hostname: string;
  port: number;
  user: string | null;
  key: ImportKey | null;
  jump: string | null;
  folder: string[];
  tags: string[];
};

export type ImportPreview = {
  source: string;
  origin: string;
  hosts: ImportedHost[];
  skipped: { name: string; reason: string }[];
};

export type ImportRow = {
  /** The source's id for this row. */
  id: string;
  /** The host name shown and created. */
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
  key: ImportKey | null;
  keyNote?: string;
  /** Another row's id, or an existing Shetu host's name. */
  jumpAlias: string | null;
  jumpNote?: string;
  folder: string[];
  tags: string[];
  existing: boolean;
};

type GroupRef = { id: string; name: string; parentId?: string | null };

export type ImportDeps = {
  /** The group the dialog was opened in; folders go below it. */
  groupId: string | null;
  source?: string;
  groups: GroupRef[];
  existingKeys: { id: string; fingerprint?: string }[];
  existingHosts: { id: string; name: string; groupId?: string | null }[];
  readKey(path: string): Promise<string>;
  convertPpk(text: string, passphrase?: string): Promise<string>;
  importKey(k: {
    id: string;
    name: string;
    encryptedPrivateKey: string;
    passphrase?: string;
  }): Promise<void>;
  createGroup(g: {
    name: string;
    parentId: string | null;
  }): Promise<{ id: string } | null>;
  createHost(h: Partial<Host>): Promise<Host | null>;
  newId(): string;
};

export type ImportSummary = {
  hostsImported: number;
  keysImported: number;
  problems: { alias: string; message: string }[];
};

const CHAIN_NOTE = "Jump chains aren't supported; imported without a jump host";

const KEY_NOTES: Partial<Record<ImportKey["status"], string>> = {
  missing: "Key file not found; imported without a key",
  unreadable: "Key file couldn't be read; imported without a key",
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The existing group a folder path resolves to below `root`; undefined if any part is new. */
function resolveFolder(
  folder: string[],
  root: string | null,
  groups: GroupRef[],
): string | null | undefined {
  let at: string | null = root;
  for (const name of folder) {
    const found = groups.find(
      (g) => (g.parentId ?? null) === at && same(g.name, name),
    );
    if (!found) return undefined;
    at = found.id;
  }
  return at;
}

export function planImport(
  preview: ImportPreview,
  ctx: {
    rootGroupId: string | null;
    groups: GroupRef[];
    hosts: { name: string; groupId?: string | null }[];
  },
): ImportRow[] {
  const byId = new Map(preview.hosts.map((h) => [h.id, h]));
  const anyExisting = (name: string) =>
    ctx.hosts.some((h) => same(h.name, name));
  const where = preview.source === "ssh_config" ? "your config" : "this import";

  return preview.hosts.map((h) => {
    const target = resolveFolder(h.folder, ctx.rootGroupId, ctx.groups);
    const row: ImportRow = {
      id: h.id,
      alias: h.name,
      hostname: h.hostname,
      user: h.user,
      port: h.port,
      key: h.key,
      jumpAlias: null,
      folder: h.folder,
      tags: h.tags,
      // A folder group that doesn't exist yet can't hold a duplicate.
      existing:
        target !== undefined &&
        ctx.hosts.some(
          (e) => (e.groupId ?? null) === target && same(e.name, h.name),
        ),
    };
    const keyNote = h.key && KEY_NOTES[h.key.status];
    if (keyNote) row.keyNote = keyNote;

    const jump = h.jump?.trim();
    if (jump) {
      const jumpTarget = byId.get(jump);
      if (jump.includes(",") || jumpTarget?.jump) row.jumpNote = CHAIN_NOTE;
      else if (jumpTarget || anyExisting(jump)) row.jumpAlias = jump;
      else row.jumpNote = `Jump host ${jump} isn't in ${where} or Shetu`;
    }
    return row;
  });
}

export async function runImport(
  rows: ImportRow[],
  passphrases: Record<string, string>,
  deps: ImportDeps,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    hostsImported: 0,
    keysImported: 0,
    problems: [],
  };
  const existingHostId = (name: string, groupId?: string | null) =>
    deps.existingHosts.find(
      (e) =>
        same(e.name, name) &&
        (groupId === undefined || (e.groupId ?? null) === groupId),
    )?.id;

  const toCreate = rows.filter((r) => !r.existing);
  for (const r of rows)
    if (r.existing)
      summary.problems.push({
        alias: r.alias,
        message: "Already in Shetu; skipped",
      });

  // Folders → groups, parent before child, reusing existing ones by name + parent.
  const known: GroupRef[] = [...deps.groups];
  const targets = new Map<string, string | null>();
  for (const r of toCreate) {
    let at = deps.groupId;
    for (const name of r.folder) {
      const found = known.find(
        (g) => (g.parentId ?? null) === at && same(g.name, name),
      );
      if (found) {
        at = found.id;
        continue;
      }
      const created = await deps
        .createGroup({ name, parentId: at })
        .catch(() => null);
      if (!created) {
        summary.problems.push({
          alias: r.alias,
          message: `Couldn't create group ${name}; imported one level up`,
        });
        break;
      }
      known.push({ id: created.id, name, parentId: at });
      at = created.id;
    }
    targets.set(r.id, at);
  }

  // An existing row keeps its Shetu id so it can still be a jump target.
  const ids = new Map<string, string>();
  for (const r of rows)
    ids.set(
      r.id,
      (r.existing &&
        existingHostId(
          r.alias,
          resolveFolder(r.folder, deps.groupId, known) ?? null,
        )) ||
        deps.newId(),
    );

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
      let text = await deps.readKey(k.path);
      // PuTTY keys become OpenSSH text, re-encrypted with the same passphrase.
      if (text.trimStart().startsWith("PuTTY-User-Key-File-"))
        text = await deps.convertPpk(text, passphrase || undefined);
      await deps.importKey({
        id,
        name: k.fileName,
        encryptedPrivateKey: text,
        passphrase: k.status === "encrypted" ? passphrase : undefined,
      });
      summary.keysImported++;
      keys.set(k.path, { keyId: id });
    } catch (e) {
      keys.set(k.path, { problem: e instanceof Error ? e.message : String(e) });
    }
  }

  // Only successfully created rows (or existing Shetu hosts) may be linked as jump hosts.
  const created = new Set<string>();
  const jumpId = (ref: string) => {
    const target = rows.find((x) => x.id === ref);
    if (!target) return existingHostId(ref);
    if (target.existing) return ids.get(ref);
    return created.has(ref) ? ids.get(ref) : undefined;
  };

  // Kept links never target a row with its own jump host, so targets are always in pass 1.
  const ordered = [
    ...toCreate.filter((r) => !r.jumpAlias),
    ...toCreate.filter((r) => r.jumpAlias),
  ];
  for (const r of ordered) {
    for (const message of [r.keyNote, r.jumpNote])
      if (message) summary.problems.push({ alias: r.alias, message });
    const outcome = r.key ? keys.get(r.key.path) : undefined;
    if (outcome?.problem)
      summary.problems.push({ alias: r.alias, message: outcome.problem });
    const keyId = outcome?.keyId;
    const jumpHostId = r.jumpAlias ? jumpId(r.jumpAlias) : undefined;
    if (r.jumpAlias && !jumpHostId) {
      const name = rows.find((x) => x.id === r.jumpAlias)?.alias ?? r.jumpAlias;
      summary.problems.push({
        alias: r.alias,
        message: `Jump host ${name} couldn't be imported; imported without a jump host`,
      });
    }
    try {
      const host = await deps.createHost({
        id: ids.get(r.id),
        name: r.alias,
        address: r.hostname,
        port: r.port,
        // ssh_config keeps its old default; other apps leave it to the connect prompt.
        username: r.user ?? (deps.source === "ssh_config" ? "root" : undefined),
        authType: keyId ? "key" : "password",
        keyId,
        jumpHostId,
        groupId: targets.get(r.id) ?? deps.groupId,
        ...(r.tags.length ? { tags: r.tags } : {}),
      });
      if (host) {
        created.add(r.id);
        summary.hostsImported++;
      } else
        summary.problems.push({
          alias: r.alias,
          message: "Couldn't create host",
        });
    } catch (e) {
      summary.problems.push({
        alias: r.alias,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return summary;
}
