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

/** One side of a comparison: a pane's provider and the folder it shows. */
export interface CompareSide {
  kind: "local" | "remote";
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
  return compareFolders(l, r);
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
const under = (root: string, rel: string) => (rel ? joinPath(root, rel) : root);

/** Copies rows across, keeping their relative paths. Changed files replace the target (the
 * arrow was the user's explicit choice); new files never overwrite anything. Never deletes. */
export async function copyRows(
  rows: CompareRow[],
  direction: Direction,
  left: CompareSide,
  right: CompareSide,
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
    await to.provider.mkdirAll(dirs.map((d) => under(to.root, d)));

  const groups = new Map<string, CompareRow[]>();
  for (const r of picked.filter((r) => !r.isDir)) {
    const parent = parentOf(r.path);
    groups.set(parent, [...(groups.get(parent) ?? []), r]);
  }
  const results: TransferFileResult[] = [];
  for (const [parent, group] of groups) {
    const files: FileItem[] = group.map((r) => {
      const e = (direction === "right" ? r.left : r.right) as CompareEntry;
      const path = under(from.root, r.path);
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
        .map((r) => [under(from.root, r.path), { action: "replace" as const }]),
    );
    results.push(
      ...(await transferFiles({
        source: from.provider,
        dest: to.provider,
        files,
        destPath: under(to.root, parent),
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
  await side.provider.removeFile(under(side.root, path));
}
