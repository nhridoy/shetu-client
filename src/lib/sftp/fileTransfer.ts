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
import type { TransferItem } from "@/stores/sftp/sftpStore";
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
  upload?(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void>;
  download?(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void>;
  serverCopy?(
    srcSessionId: string,
    srcPath: string,
    destPath: string,
    totalBytes: number,
    transferId?: string,
  ): Promise<void>;
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
      return { file, relativePath: renamed, destFilePath, skip: false };
    }

    return { file, relativePath: remapped, destFilePath, skip: skipped };
  });
}

function determineDirection(
  source: FileProvider,
  dest: FileProvider,
): "upload" | "download" | "copy" {
  if (source.type === "remote" && dest.type === "local") return "download";
  if (source.type === "local" && dest.type === "remote") return "upload";
  return "copy";
}

const MAX_CONCURRENT = 3;

export interface TransferFileResult {
  file: FileItem;
  action: "moved" | "copied" | "skipped";
  error?: string;
}

// Force a transfer to "complete". Rust upload/download/serverCopy emit
// progress events, but a 0-byte file produces no events, leaving the item
// stuck at "pending"/"active" forever. Call this after the op returns.
function finalizeTransfer(transferId: string, size: number): void {
  useSftpStore.getState().updateTransfer(transferId, {
    status: "complete",
    progress: 1,
    transferred: size,
    size,
  });
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

async function transferSingleFile(
  source: FileProvider,
  dest: FileProvider,
  file: FileItem,
  destFilePath: string,
  sessionId?: string,
): Promise<TransferFileResult> {
  const direction = determineDirection(source, dest);

  // Create TransferItem for this file
  const transferId = crypto.randomUUID();
  const transferItem: TransferItem = {
    id: transferId,
    fileName: file.name,
    localPath: source.type === "local" ? file.path : undefined,
    remotePath: dest.type === "remote" ? destFilePath : undefined,
    direction,
    status: "pending",
    progress: 0,
    size: file.size,
    transferred: 0,
    sessionId,
  };

  // Dynamically import store to avoid circular dependency
  const { useSftpStore } = await import("@/stores/sftp/sftpStore");
  useSftpStore.getState().addTransfer(transferItem);

  try {
    if (source.type === "local" && dest.type === "local") {
      // Local→Local: use native fs (instant, no progress events)
      await dest.copyFile(file.path, destFilePath);
      finalizeTransfer(transferId, file.size);
      return { file, action: "copied" };
    }

    if (source.type === "local" && dest.type === "remote" && dest.upload) {
      // Local→Remote: stream via Rust upload
      await dest.upload(file.path, destFilePath, undefined, transferId);
      finalizeTransfer(transferId, file.size);
      return { file, action: "copied" };
    }

    if (source.type === "remote" && dest.type === "local" && source.download) {
      // Remote→Local: stream via Rust download
      await source.download(file.path, destFilePath, undefined, transferId);
      finalizeTransfer(transferId, file.size);
      return { file, action: "copied" };
    }

    if (source.type === "remote" && dest.type === "remote") {
      // Remote→Remote: direct server-side streaming (no temp file, no JS memory)
      if (
        "serverCopy" in source &&
        typeof source.serverCopy === "function" &&
        "getSessionId" in dest
      ) {
        const destWithSession = dest as { getSessionId: () => string };
        await source.serverCopy(
          destWithSession.getSessionId(),
          file.path,
          destFilePath,
          file.size,
          transferId,
        );
        finalizeTransfer(transferId, file.size);
        return { file, action: "copied" };
      }
      // Fallback shouldn't happen with valid providers
      throw new Error(
        "Server-to-server copy not supported between these providers",
      );
    }

    // Fallback: shouldn't reach here with valid providers
    const data = await source.readFile(file.path);
    await dest.writeFile(destFilePath, data);
    finalizeTransfer(transferId, file.size);
    return { file, action: "copied" };
  } catch (err) {
    useSftpStore.getState().updateTransfer(transferId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
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
    sessionId,
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
    }[] = [];

    for (const { file, skip, destFilePath } of resolvedEntries) {
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

      transfers.push({ file, destFilePath });
    }

    // Process transfers in parallel batches
    for (let i = 0; i < transfers.length; i += MAX_CONCURRENT) {
      const batch = transfers.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.allSettled(
        batch.map(async (t, batchIdx) => {
          const globalIdx = i + batchIdx;
          onFileStart?.(t.file, globalIdx);

          // Same-provider local move: instant, no TransferItem. Cross-volume
          // moves copy then delete the source instead of rename.
          if (localMove) {
            if (sameVolumeMove) {
              await source.moveFile(t.file.path, t.destFilePath);
            } else {
              await source.copyFile(t.file.path, t.destFilePath);
              await source.removeFile(t.file.path);
            }
            return { file: t.file, action: "moved" as const };
          }

          return transferSingleFile(
            source,
            dest,
            t.file,
            t.destFilePath,
            sessionId,
          );
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

    // Show summary toast
    const errors = results.filter((r) => r.error);
    const successes = results.filter((r) => !r.error && r.action !== "skipped");
    const skipped = results.filter((r) => r.action === "skipped");

    if (errors.length === 0 && successes.length > 0) {
      const count = successes.length;
      const verb = mode === "move" ? "Moved" : "Copied";
      const name = count === 1 ? successes[0].file.name : `${count} files`;
      toast.success(`${verb} ${name}`);
    } else if (errors.length > 0 && successes.length === 0) {
      toast.error(`Failed to transfer: ${errors[0].error || "Unknown error"}`);
    } else if (errors.length > 0) {
      toast.warning(
        `Transferred ${successes.length} files, ${errors.length} failed`,
      );
    }

    if (skipped.length > 0 && successes.length === 0 && errors.length === 0) {
      // All skipped — no toast
    }

    return results;
  } finally {
    useSftpStore.getState().setTransferScanning(false);
  }
}
