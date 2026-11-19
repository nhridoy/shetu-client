import type { FileItem } from "@/types/sftp/sftpTypes";

/** One file or folder, relative to the compared folder (`/`-separated, mtime in seconds). */
export interface CompareEntry {
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export type CompareStatus =
  | "onlyLeft"
  | "onlyRight"
  | "differs"
  | "same"
  | "conflict";

export interface CompareRow {
  path: string;
  status: CompareStatus;
  isDir: boolean;
  left?: CompareEntry;
  right?: CompareEntry;
}

/** Modified times this close count as equal (SFTP keeps whole seconds; filesystems round). */
const TIME_TOLERANCE_S = 2;

function sameFile(a: CompareEntry, b: CompareEntry): boolean {
  return a.size === b.size && Math.abs(a.mtime - b.mtime) <= TIME_TOLERANCE_S;
}

/**
 * Diffs two folder listings. Folders on both sides aren't rows; a folder on one side only is a
 * row only when it is empty there (otherwise its files carry it). A file against a folder is a
 * `conflict`, never copied.
 */
export function compareFolders(
  left: CompareEntry[],
  right: CompareEntry[],
): CompareRow[] {
  const byPath = (entries: CompareEntry[]) =>
    new Map(entries.map((e) => [e.path, e]));
  const l = byPath(left);
  const r = byPath(right);
  const hasChildren = (entries: CompareEntry[], dir: string) =>
    entries.some((e) => e.path.startsWith(`${dir}/`));
  const rows: CompareRow[] = [];
  for (const path of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(path);
    const b = r.get(path);
    if (a && b) {
      if (a.isDir && b.isDir) continue;
      const status: CompareStatus =
        a.isDir !== b.isDir ? "conflict" : sameFile(a, b) ? "same" : "differs";
      rows.push({ path, status, isDir: a.isDir && b.isDir, left: a, right: b });
    } else if (a) {
      if (a.isDir && hasChildren(left, path)) continue;
      rows.push({ path, status: "onlyLeft", isDir: a.isDir, left: a });
    } else if (b) {
      if (b.isDir && hasChildren(right, path)) continue;
      rows.push({ path, status: "onlyRight", isDir: b.isDir, right: b });
    }
  }
  return rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Turns a provider's recursive listing into entries relative to `root`. */
export function toCompareEntries(
  root: string,
  items: FileItem[],
): CompareEntry[] {
  // Only Windows local paths use `\` as a separator; on POSIX it is part of a file name.
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  const normalize = (p: string) =>
    (windows ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
  const base = `${normalize(root)}/`;
  return items
    .map((item) => {
      const full = normalize(item.path);
      const path = full.startsWith(base) ? full.slice(base.length) : full;
      return {
        path,
        isDir: item.type === "directory",
        size: item.size,
        mtime: Math.floor(Date.parse(item.modifiedAt) / 1000) || 0,
      };
    })
    .filter((e) => e.path.length > 0);
}
