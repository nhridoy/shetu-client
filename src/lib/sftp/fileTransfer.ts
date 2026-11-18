import { toast } from "sonner";
import {
  copyLocalFile,
  createLocalDir,
  isLocalDirectory,
  isSameVolume,
  listLocalFiles,
  listLocalFilesRecursive,
  moveLocalFile,
  readLocalFileBytes,
  writeLocalFileBytes,
} from "@/lib/sftp/localFs";
import {
  enqueueTransfers,
  isSettled,
  type TransferJob,
  type TransferKind,
} from "@/lib/sftp/transfers";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

export type ProgressCallback = (loaded: number, total: number) => void;

export interface FileProvider {
  type: "local" | "remote";
  id: string;
  listFiles(path: string): Promise<FileItem[]>;
  listFilesRecursive(path: string, basePath?: string): Promise<FileItem[]>;
  isDirectory(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    onProgress?: ProgressCallback,
  ): Promise<void>;
  moveFile(source: string, dest: string): Promise<void>;
  copyFile(source: string, dest: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  mkdirAll(paths: string[]): Promise<void>;
}

export class LocalFileProvider implements FileProvider {
  type = "local" as const;
  id: string;

  constructor(id?: string) {
    this.id = id ?? "local";
  }

  async listFiles(path: string): Promise<FileItem[]> {
    return listLocalFiles(path);
  }

  async listFilesRecursive(
    path: string,
    basePath?: string,
  ): Promise<FileItem[]> {
    return listLocalFilesRecursive(path, basePath);
  }

  async isDirectory(path: string): Promise<boolean> {
    return isLocalDirectory(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readLocalFileBytes(path);
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    await writeLocalFileBytes(path, data);
    onProgress?.(data.length, data.length);
  }

  async moveFile(source: string, dest: string): Promise<void> {
    await moveLocalFile(source, dest);
  }

  async copyFile(source: string, dest: string): Promise<void> {
    await copyLocalFile(source, dest);
  }

  async removeFile(path: string): Promise<void> {
    const { removeLocalFile } = await import("@/lib/sftp/localFs");
    await removeLocalFile(path);
  }

  async exists(path: string): Promise<boolean> {
    const { localFileExists } = await import("@/lib/sftp/localFs");
    return localFileExists(path);
  }

  async mkdir(path: string): Promise<void> {
    await createLocalDir(path);
  }

  async mkdirAll(paths: string[]): Promise<void> {
    for (const p of paths) {
      await createLocalDir(p).catch(() => {});
    }
  }
}

export function getSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function parentPath(path: string): string {
  const sep = getSeparator(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) {
    if (path.startsWith("/")) return "/";
    const drive = trimmed.match(/^[A-Za-z]:$/);
    return drive ? `${trimmed}${sep}` : "";
  }
  const parent = trimmed.slice(0, idx);
  if (parent === "" || parent.endsWith(":")) return parent + sep;
  return parent;
}

export function joinPath(...parts: string[]): string {
  if (parts.length === 0) return "";
  const sep = getSeparator(parts.find((p) => p.includes("\\")) ?? parts[0]);
  const other = sep === "\\" ? "/" : "\\";
  return parts
    .map((p, i) => {
      let s = p.split(other).join(sep);
      if (i === 0) {
        while (s.endsWith(sep)) s = s.slice(0, -1);
      } else if (i === parts.length - 1) {
        while (s.startsWith(sep)) s = s.slice(1);
      } else {
        while (s.startsWith(sep)) s = s.slice(1);
        while (s.endsWith(sep)) s = s.slice(0, -1);
      }
      return s;
    })
    .filter(Boolean)
    .join(sep);
}

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function dirNameFromPath(path: string): string {
  const sep = getSeparator(path);
  const parts = path.split(sep);
  parts.pop();
  return parts.join(sep) || sep;
}

export async function checkConflicts(
  files: FileItem[],
  destPath: string,
  destProvider: FileProvider,
): Promise<FileItem[]> {
  let destFiles: FileItem[];
  try {
    destFiles = await destProvider.listFiles(destPath);
  } catch {
    return [];
  }
  const destNames = new Set(destFiles.map((f) => f.name));
  return files.filter((f) => destNames.has(f.name));
}

function generateAutoName(
  originalName: string,
  existingNames: Set<string>,
): string {
  const dot = originalName.lastIndexOf(".");
  const base = dot > 0 ? originalName.substring(0, dot) : originalName;
  const ext = dot > 0 ? originalName.substring(dot) : "";
  let candidate = `${base} (copy)${ext}`;
  let counter = 2;
  while (existingNames.has(candidate)) {
    candidate = `${base} (copy ${counter})${ext}`;
    counter++;
  }
  return candidate;
}

export type TransferOverride = {
  action: "replace" | "rename" | "auto" | "skip";
  newName?: string;
};

export interface TransferPathEntry {
  file: FileItem;
  relativePath: string;
  destFilePath: string;
  skip: boolean;
  /** The user approved replacing what's at the destination (this entry or its root folder). */
  replace: boolean;
}

/**
 * Resolves destination names for expanded transfer items, honoring
 * per-item overrides (replace/rename/auto/skip) for top-level files AND
 * directories. Directory renames/skips propagate to all children, so
 * callers must create directories only after resolution.
 */
export function resolveTransferPaths(
  expandedFiles: { file: FileItem; relativePath: string }[],
  destPath: string,
  mode: "move" | "copy",
  overrides?: Map<string, TransferOverride>,
  existingNames?: Set<string>,
): TransferPathEntry[] {
  const names = existingNames ?? new Set<string>();

  // Resolve the top-level name for each root item (file or directory).
  // Only the root item itself carries the override key: children are
  // expanded BEFORE the directory entry, so they must not decide the root
  // resolution (otherwise replace/rename/skip on a folder would fall
  // through to the copy auto-rename).
  const nameMap = new Map<string, string>();
  const skippedRoots = new Set<string>();
  const replacedRoots = new Set<string>();
  for (const item of expandedFiles) {
    const rootName = item.relativePath.split(/[/\\]/)[0];
    if (item.relativePath !== rootName) continue;
    if (nameMap.has(rootName) || skippedRoots.has(rootName)) continue;
    const override = overrides?.get(item.file.path);
    if (override?.action === "skip") {
      skippedRoots.add(rootName);
      continue;
    }
    let resolved = rootName;
    if (override?.action === "replace") {
      // Explicit overwrite — keep the name
      resolved = rootName;
      replacedRoots.add(rootName);
    } else if (override?.action === "auto") {
      resolved = generateAutoName(rootName, names);
    } else if (override?.action === "rename" && override.newName) {
      resolved = override.newName;
    } else if (mode === "copy" && names.has(rootName)) {
      // Copying onto an existing item (incl. paste into same folder):
      // auto-rename like a file manager instead of overwriting/failing.
      resolved = generateAutoName(rootName, names);
    }
    nameMap.set(rootName, resolved);
    names.add(resolved);
  }

  return expandedFiles.map(({ file, relativePath }) => {
    const rootName = relativePath.split(/[/\\]/)[0];
    const skipped = skippedRoots.has(rootName);
    const resolvedName = nameMap.get(rootName);
    const remapped =
      resolvedName && resolvedName !== rootName
        ? resolvedName + relativePath.slice(rootName.length)
        : relativePath;

    let destFilePath = joinPath(destPath, remapped);

    // Paste into the same folder: auto-rename the leaf to avoid a
    // self-copy / "file in use" (os error 32) failure
    if (mode === "copy" && destFilePath === file.path) {
      const segs = remapped.split(/[/\\]/);
      const leaf = segs.pop() ?? file.name;
      segs.push(generateAutoName(leaf, names));
      const renamed = segs.join("/");
      destFilePath = joinPath(destPath, renamed);
      return {
        file,
        relativePath: renamed,
        destFilePath,
        skip: false,
        replace: false,
      };
    }

    return {
      file,
      relativePath: remapped,
      destFilePath,
      skip: skipped,
      replace: replacedRoots.has(rootName),
    };
  });
}

/** Which manager job moves a file between these providers; null for this computer to itself. */
function transferKind(
  source: FileProvider,
  dest: FileProvider,
): TransferKind | null {
  if (source.type === "remote" && dest.type === "local") return "download";
  if (source.type === "local" && dest.type === "remote") return "upload";
  if (source.type === "remote" && dest.type === "remote") return "serverCopy";
  return null;
}

function sessionIdOf(provider: FileProvider): string | undefined {
  if (provider.type !== "remote") return undefined;
  return (provider as unknown as { getSessionId(): string }).getSessionId();
}

const MAX_CONCURRENT = 3;

export interface TransferFileResult {
  file: FileItem;
  /** "waiting": handed to the transfer queue but not finished (paused or waiting for a host). */
  action: "moved" | "copied" | "skipped" | "waiting";
  error?: string;
}

/** Resolves once every job has settled (see `isSettled`), with each job's settled state. */
function waitForSettled(jobs: TransferJob[]): Promise<TransferJob[]> {
  const ids = jobs.map((j) => j.id);
  const seen = new Map<string, TransferJob>();
  const resets = useSftpStore.getState().transferResets;
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const check = (state: {
      transfers: TransferJob[];
      transferResets: number;
    }) => {
      for (const job of state.transfers) {
        if (ids.includes(job.id) && isSettled(job)) seen.set(job.id, job);
      }
      // A wipe removed the queue: whatever hadn't settled is cancelled.
      if (state.transferResets !== resets) {
        for (const job of jobs) {
          if (!seen.has(job.id))
            seen.set(job.id, { ...job, status: "cancelled" });
        }
      }
      if (seen.size < ids.length) return false;
      unsubscribe?.();
      resolve(ids.map((id) => seen.get(id) as TransferJob));
      return true;
    };
    if (check(useSftpStore.getState())) return;
    unsubscribe = useSftpStore.subscribe((state) => {
      check(state);
    });
  });
}

function resultFor(file: FileItem, job: TransferJob): TransferFileResult {
  switch (job.status) {
    case "done":
      return { file, action: "copied" };
    case "failed":
      return { file, action: "copied", error: job.error ?? "Transfer failed" };
    case "cancelled":
      return { file, action: "copied", error: "Cancelled" };
    default:
      return { file, action: "waiting" };
  }
}

export interface TransferOptions {
  source: FileProvider;
  dest: FileProvider;
  files: FileItem[];
  destPath: string;
  mode: "move" | "copy";
  sessionId?: string;
  overrides?: Map<string, TransferOverride>;
  onFileStart?: (file: FileItem, index: number) => void;
  onFileProgress?: (
    file: FileItem,
    index: number,
    loaded: number,
    total: number,
  ) => void;
  onFileComplete?: (
    file: FileItem,
    index: number,
    result: TransferFileResult,
  ) => void;
}

/**
 * Renames `from` onto `to`. With `replacing`, the old `to` is set aside and only deleted once the
 * new file is in place; on any failure it is put back, or the error says where it is kept.
 */
async function moveReplacing(
  provider: FileProvider,
  from: string,
  to: string,
  replacing: boolean,
): Promise<void> {
  if (!replacing) return provider.moveFile(from, to);
  // Short, so it fits even when `to`'s own name is at the filesystem's length limit.
  const backup = joinPath(
    parentPath(to),
    `.shetu-replace-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    await provider.moveFile(to, backup);
    await provider.moveFile(from, to);
  } catch (err) {
    // A rename's reply can be lost after the server applied it: look for the old file.
    if (await provider.exists(backup).catch(() => true)) {
      const restored = await provider.moveFile(backup, to).then(
        () => true,
        () => false,
      );
      if (!restored) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${message}. The previous file is kept at ${backup}`);
      }
    }
    throw err;
  }
  // A backup that is a folder (the target changed meanwhile) is never deleted.
  const isFolder = await provider.isDirectory(backup).catch(() => true);
  const cleaned =
    !isFolder &&
    (await provider.removeFile(backup).then(
      () => true,
      () => false,
    ));
  if (!cleaned) {
    toast.warning(`Moved, but the previous version is still at ${backup}`);
  }
}

/** One toast for the whole batch. */
function showSummary(
  results: TransferFileResult[],
  mode: "move" | "copy",
): void {
  const errors = results.filter((r) => r.error);
  const successes = results.filter(
    (r) => !r.error && r.action !== "skipped" && r.action !== "waiting",
  );
  const waiting = results.filter((r) => r.action === "waiting");
  const waitingNote = waiting.length > 0 ? `, ${waiting.length} waiting` : "";

  if (errors.length === 0 && waiting.length > 0) {
    toast(
      successes.length > 0
        ? `Transferred ${successes.length} files${waitingNote}`
        : `${waiting.length} waiting`,
    );
  } else if (errors.length === 0 && successes.length > 0) {
    const count = successes.length;
    const verb = mode === "move" ? "Moved" : "Copied";
    const name = count === 1 ? successes[0].file.name : `${count} files`;
    toast.success(`${verb} ${name}`);
  } else if (
    errors.length > 0 &&
    successes.length === 0 &&
    waiting.length === 0
  ) {
    toast.error(`Failed to transfer: ${errors[0].error || "Unknown error"}`);
  } else if (errors.length > 0) {
    toast.warning(
      `Transferred ${successes.length} files, ${errors.length} failed${waitingNote}`,
    );
  }
}

export async function transferFiles(
  options: TransferOptions,
): Promise<TransferFileResult[]> {
  const {
    source,
    dest,
    files,
    destPath,
    mode,
    overrides,
    onFileStart,
    onFileComplete,
  } = options;

  const results: TransferFileResult[] = [];
  const isSameProvider = source.id === dest.id;
  useSftpStore.getState().setTransferScanning(true);
  try {
    const existingNames = new Set(
      (await dest.listFiles(destPath).catch(() => [])).map((f) => f.name),
    );

    // Moving within one remote pane is a rename: whole files and folders, no copy.
    if (isSameProvider && source.type === "remote" && mode === "move") {
      // What is really there; resolveTransferPaths also reserves the names it hands out.
      const listedNames = new Set(existingNames);
      const roots = resolveTransferPaths(
        files.map((file) => ({ file, relativePath: file.name })),
        destPath,
        mode,
        overrides,
        existingNames,
      );
      for (const [
        i,
        { file, destFilePath, skip, replace },
      ] of roots.entries()) {
        let result: TransferFileResult;
        if (skip || destFilePath === file.path) {
          // Pasting a cut file back into its own folder is a no-op, never a delete.
          result = { file, action: "skipped" };
        } else {
          try {
            // SFTP rename refuses an existing target. An approved Replace moves the old file
            // aside first and only deletes it once the new one is in place.
            // shortcut: Replace onto an existing folder isn't merged (the rename fails and is
            // reported); merge would move children one by one.
            const replacing =
              replace &&
              file.type !== "directory" &&
              listedNames.has(fileNameFromPath(destFilePath));
            await moveReplacing(source, file.path, destFilePath, replacing);
            result = { file, action: "moved" };
          } catch (err) {
            result = {
              file,
              action: "moved",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
        results.push(result);
        onFileComplete?.(file, i, result);
      }
      showSummary(results, mode);
      return results;
    }

    // A same-provider local move can only use rename() when both sides are on
    // the same volume; otherwise it must copy each file then delete the source
    // (std::fs::rename fails with "os error 17" across drives).
    const localMove =
      isSameProvider &&
      source.type === "local" &&
      dest.type === "local" &&
      mode === "move";
    let sameVolumeMove = true;
    if (localMove) {
      const sourceRoot = files[0]?.path ?? destPath;
      sameVolumeMove = await isSameVolume(sourceRoot, destPath).catch(
        () => false,
      );
    }

    // Expand directories recursively and collect all files
    const expandedFiles: { file: FileItem; relativePath: string }[] = [];
    for (const file of files) {
      const isDir = file.type === "directory";
      if (isDir) {
        // Recursively list all files in the directory
        const allFiles = await source.listFilesRecursive(file.path, file.path);
        for (const subFile of allFiles) {
          // Skip the root directory itself
          if (subFile.path === file.path) continue;
          // Relative path from the source dir root, normalized to POSIX
          // (forward slashes) so joinPath(destPath, relativePath) uses the
          // destination provider's own separator on the whole path.
          const subRel = subFile.path
            .slice(file.path.length)
            .replace(/^[/\\]+/, "")
            .split(/[\\/]+/)
            .filter(Boolean)
            .join("/");
          const relativePath = [file.name, subRel].filter(Boolean).join("/");
          expandedFiles.push({ file: subFile, relativePath });
        }
        // Also add the directory itself (for mkdir on dest)
        expandedFiles.push({ file, relativePath: file.name });
      } else {
        expandedFiles.push({ file, relativePath: file.name });
      }
    }

    // Resolve destination names BEFORE creating directories so override
    // renames/skips (incl. for folders) propagate to children and mkdir.
    const resolvedEntries = resolveTransferPaths(
      expandedFiles,
      destPath,
      mode,
      overrides,
      existingNames,
    );

    // Create directory structure on destination first
    const dirsToCreate = new Set<string>();
    for (const { file, relativePath, skip } of resolvedEntries) {
      if (skip) continue;
      if (file.type === "directory") {
        dirsToCreate.add(joinPath(destPath, relativePath));
      } else if (relativePath.includes("/") || relativePath.includes("\\")) {
        // File is inside a subdirectory - ensure parent dirs exist
        const parts = relativePath.split(/[/\\]/);
        parts.pop(); // Remove filename
        let dir = destPath;
        for (const part of parts) {
          dir = joinPath(dir, part);
          dirsToCreate.add(dir);
        }
      }
    }

    // Sort by depth so parents are created before children
    const sortedDirs = [...dirsToCreate].sort(
      (a, b) => a.split(/[/\\]/).length - b.split(/[/\\]/).length,
    );
    if (sortedDirs.length > 0) {
      await dest.mkdirAll(sortedDirs);
    }

    // Build the transfer list, filtering skips
    const transfers: {
      file: FileItem;
      destFilePath: string;
      replace: boolean;
    }[] = [];

    for (const { file, skip, destFilePath, replace } of resolvedEntries) {
      // Skip directories - they're already created
      if (file.type === "directory") continue;

      if (skip) {
        results.push({ file, action: "skipped" });
        onFileComplete?.(file, results.length - 1, {
          file,
          action: "skipped",
        });
        continue;
      }

      const override = overrides?.get(file.path);
      if (override?.action === "skip") {
        results.push({ file, action: "skipped" });
        onFileComplete?.(file, results.length - 1, {
          file,
          action: "skipped",
        });
        continue;
      }

      transfers.push({ file, destFilePath, replace });
    }

    const kind = transferKind(source, dest);
    if (kind && transfers.length > 0) {
      // Remote transfers go to the Rust transfer queue (resume, retries, 3 at a time).
      // Without the listener no job change would arrive and this would wait forever.
      if (!(await useSftpStore.getState().ensureTransferListener())) {
        throw new Error("The transfer queue isn't available. Try again.");
      }
      transfers.forEach((t, i) => {
        onFileStart?.(t.file, i);
      });
      const jobs = await enqueueTransfers(
        transfers.map((t) => ({
          kind,
          srcPath: t.file.path,
          destPath: t.destFilePath,
          srcSessionId: sessionIdOf(source),
          destSessionId: sessionIdOf(dest),
          replace: t.replace,
        })),
      );
      useSftpStore.getState().setTransferScanning(false);
      const settled = await waitForSettled(jobs);
      settled.forEach((job, i) => {
        const result = resultFor(transfers[i].file, job);
        results.push(result);
        onFileComplete?.(transfers[i].file, i, result);
      });
      transfers.length = 0;
    }

    // Process transfers in parallel batches
    for (let i = 0; i < transfers.length; i += MAX_CONCURRENT) {
      const batch = transfers.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.allSettled(
        batch.map(async (t, batchIdx) => {
          const globalIdx = i + batchIdx;
          onFileStart?.(t.file, globalIdx);

          // Same-provider local move: instant. Cross-volume moves copy then
          // delete the source instead of rename.
          if (localMove) {
            if (sameVolumeMove) {
              await source.moveFile(t.file.path, t.destFilePath);
            } else {
              await source.copyFile(t.file.path, t.destFilePath);
              await source.removeFile(t.file.path);
            }
            return { file: t.file, action: "moved" as const };
          }

          // This computer to itself: native copy, no queue.
          await dest.copyFile(t.file.path, t.destFilePath);
          return { file: t.file, action: "copied" as const };
        }),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        const globalIdx = i + j;
        if (r.status === "fulfilled") {
          results.push(r.value);
          onFileComplete?.(batch[j].file, globalIdx, r.value);
        } else {
          const result: TransferFileResult = {
            file: batch[j].file,
            action: "copied",
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
          results.push(result);
          onFileComplete?.(batch[j].file, globalIdx, result);
        }
      }
    }

    // Same-provider local move: remove the now-empty source directories
    // (files were moved/copied out). Deepest first so children empty before
    // parents; non-recursive removal so a dir that still holds content (e.g.
    // a file that failed to transfer) is left untouched.
    if (localMove) {
      const dirs = resolvedEntries
        .filter((e) => e.file.type === "directory" && !e.skip)
        .map((e) => e.file.path)
        .sort((a, b) => {
          const depth = (p: string) => p.split(/[/\\]/).length;
          return depth(b) - depth(a);
        });
      const { removeEmptyLocalDir } = await import("@/lib/sftp/localFs");
      for (const dir of dirs) {
        await removeEmptyLocalDir(dir).catch(() => {});
      }
    }

    showSummary(results, mode);
    return results;
  } finally {
    useSftpStore.getState().setTransferScanning(false);
  }
}
