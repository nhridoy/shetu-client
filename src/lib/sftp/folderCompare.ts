import { invoke } from "@tauri-apps/api/core";
import {
  type CompareEntry,
  type CompareRow,
  compareFolders,
  toCompareEntries,
} from "@/lib/sftp/compareFolders";
import {
  type FileProvider,
  joinPath,
  type TransferFileResult,
  transferFiles,
} from "@/lib/sftp/fileTransfer";
import type { FileItem } from "@/types/sftp/sftpTypes";

export const COMPARE_CAP = 20000;
export const TOO_MANY = "Too many files to compare; pick a smaller folder";
const BUCKET_STATS_AT_ONCE = 8;

/** One side of a comparison: a pane's provider and the folder it shows. */
export interface CompareSide {
  kind: "local" | "remote" | "storage";
  provider: FileProvider;
  root: string;
}

export type Direction = "right" | "left";

/** A side's files with sizes and times. Local folders come from Rust (the web-side local
 * listing has neither); remote ones from the pane's provider. */
export async function listSide(side: CompareSide): Promise<CompareEntry[]> {
  if (side.kind === "local") {
    return invoke<CompareEntry[]>("local_list_recursive", {
      path: side.root,
      cap: COMPARE_CAP,
    });
  }
  const items = await side.provider.listFilesRecursive(side.root, side.root);
  if (items.length > COMPARE_CAP) throw new Error(TOO_MANY);
  return toCompareEntries(side.root, items);
}

/** Both listings, then the diff. A listing error fails the whole comparison: a partial
 * listing would show files as missing that aren't. */
export async function loadComparison(
  left: CompareSide,
  right: CompareSide,
): Promise<CompareRow[]> {
  const [l, r] = await Promise.all([listSide(left), listSide(right)]);
  return compareFolders(l, r, {
    sizeOnly: left.kind === "storage" || right.kind === "storage",
  });
}

/** Changed rows with each bucket side's times read as the files' own (saved with each upload):
 * a bucket listing dates objects by upload, which would skew the newer-file check either way. */
export async function withBucketTimes(
  rows: CompareRow[],
  left: CompareSide,
  right: CompareSide,
): Promise<CompareRow[]> {
  const buckets = (
    [
      ["left", left],
      ["right", right],
    ] as const
  ).filter(([, side]) => side.kind === "storage");
  if (buckets.length === 0) return rows;
  const out = [...rows];
  let next = 0;
  // A few requests at a time: thousands of changed rows mustn't all hit the bucket at once.
  const worker = async () => {
    while (next < out.length) {
      const i = next++;
      const row = out[i];
      if (row.status !== "differs") continue;
      let timed = row;
      for (const [key, side] of buckets) {
        const there = row[key];
        if (!there) continue;
        const bucket = side.provider as unknown as {
          statTimes(
            path: string,
          ): Promise<{ size: number; mtime: number } | null>;
        };
        const times = await bucket.statTimes(under(side, row.path));
        if (times)
          timed = { ...timed, [key]: { ...there, mtime: times.mtime } };
      }
      out[i] = timed;
    }
  };
  await Promise.all(Array.from({ length: BUCKET_STATS_AT_ONCE }, worker));
  return out;
}

/** Changed rows whose copy on the target side is newer: Sync would replace them. */
export function newerOnTarget(
  rows: CompareRow[],
  direction: Direction,
): CompareRow[] {
  return rows.filter((r) => {
    if (r.status !== "differs" || !r.left || !r.right) return false;
    const [source, target] =
      direction === "right" ? [r.left, r.right] : [r.right, r.left];
    return target.mtime - source.mtime > 2;
  });
}

/** Rows a direction may copy: new and changed files (and empty folders) on the source side. */
export function copyable(
  rows: CompareRow[],
  direction: Direction,
): CompareRow[] {
  const only = direction === "right" ? "onlyLeft" : "onlyRight";
  return rows.filter((r) => r.status === only || r.status === "differs");
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
/** A row's path on a side. Bucket keys always use `/` (a `\\` there is part of a name). */
const under = (side: CompareSide, rel: string) =>
  !rel
    ? side.root
    : side.kind === "storage"
      ? `${side.root.replace(/\/+$/, "")}/${rel}`
      : joinPath(side.root, rel);

/** Copies rows across, keeping their relative paths. Changed files replace the target (the
 * arrow was the user's explicit choice); new files never overwrite anything. Never deletes. */
export async function copyRows(
  rows: CompareRow[],
  direction: Direction,
  left: CompareSide,
  right: CompareSide,
  /** Checked before each folder's transfer: false (a pane reconnected) stops the copy. */
  stillListed: () => boolean = () => true,
): Promise<TransferFileResult[]> {
  const [from, to] = direction === "right" ? [left, right] : [right, left];
  const picked = copyable(rows, direction);
  const folders = new Set<string>();
  for (const r of picked) {
    const parent = r.isDir ? r.path : parentOf(r.path);
    if (parent) folders.add(parent);
  }
  const dirs = [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  if (dirs.length > 0)
    await to.provider.mkdirAll(dirs.map((d) => under(to, d)));

  const groups = new Map<string, CompareRow[]>();
  for (const r of picked.filter((r) => !r.isDir)) {
    const parent = parentOf(r.path);
    groups.set(parent, [...(groups.get(parent) ?? []), r]);
  }
  const results: TransferFileResult[] = [];
  for (const [parent, group] of groups) {
    if (!stillListed()) break;
    const files: FileItem[] = group.map((r) => {
      const e = (direction === "right" ? r.left : r.right) as CompareEntry;
      const path = under(from, r.path);
      return {
        name: r.path.split("/").pop() ?? r.path,
        path,
        type: "file",
        size: e.size,
        permissions: "",
        owner: "",
        group: "",
        modifiedAt: new Date(e.mtime * 1000).toISOString(),
        isHidden: false,
      };
    });
    const overrides = new Map(
      group
        .filter((r) => r.status === "differs")
        .map((r) => [under(from, r.path), { action: "replace" as const }]),
    );
    results.push(
      ...(await transferFiles({
        source: from.provider,
        dest: to.provider,
        files,
        destPath: under(to, parent),
        mode: "copy",
        overrides,
        silent: true,
      })),
    );
  }
  return results;
}

/** Deletes a file (or empty folder) that exists only on `side`. The caller confirms first. */
export async function deleteEntry(
  side: CompareSide,
  path: string,
): Promise<void> {
  await side.provider.removeFile(under(side, path));
}
