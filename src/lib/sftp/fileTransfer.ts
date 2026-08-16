import { toast } from "sonner";
import {
  copyLocalFile,
  createLocalDir,
  listLocalFiles,
  moveLocalFile,
  readLocalFileBytes,
  writeLocalFileBytes,
} from "@/lib/sftp/localFs";
import type { TransferItem } from "@/stores/sftp/sftpStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

export type ProgressCallback = (loaded: number, total: number) => void;

export interface FileProvider {
  type: "local" | "remote";
  id: string;
  listFiles(path: string): Promise<FileItem[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    onProgress?: ProgressCallback,
  ): Promise<void>;
  moveFile(source: string, dest: string): Promise<void>;
  copyFile(source: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
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

  async exists(path: string): Promise<boolean> {
    const { localFileExists } = await import("@/lib/sftp/localFs");
    return localFileExists(path);
  }

  async mkdir(path: string): Promise<void> {
    await createLocalDir(path);
  }
}

export function getSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function joinPath(...parts: string[]): string {
  if (parts.length === 0) return "";
  const sep = getSeparator(parts.find((p) => p.includes("\\")) ?? parts[0]);
  return parts
    .map((p, i) => {
      if (i === 0) return p.replace(/[\\/]+$/, "");
      if (i === parts.length - 1) return p.replace(/^[\\/]+/, "");
      return p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
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

export interface TransferOptions {
  source: FileProvider;
  dest: FileProvider;
  files: FileItem[];
  destPath: string;
  mode: "move" | "copy";
  sessionId?: string;
  overrides?: Map<
    string,
    { action: "replace" | "rename" | "auto" | "skip"; newName?: string }
  >;
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
      // Mark complete immediately (no progress events for local ops)
      useSftpStore.getState().updateTransfer(transferId, {
        status: "complete",
        progress: 1,
        transferred: file.size,
        size: file.size,
      });
      return { file, action: "copied" };
    }

    if (source.type === "local" && dest.type === "remote" && dest.upload) {
      // Local→Remote: stream via Rust upload
      await dest.upload(file.path, destFilePath, undefined, transferId);
      return { file, action: "copied" };
    }

    if (source.type === "remote" && dest.type === "local" && source.download) {
      // Remote→Local: stream via Rust download
      await source.download(file.path, destFilePath, undefined, transferId);
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
    useSftpStore.getState().updateTransfer(transferId, {
      status: "complete",
      progress: 1,
      transferred: file.size,
      size: file.size,
    });
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

  const existingNames = new Set(
    (await dest.listFiles(destPath).catch(() => [])).map((f) => f.name),
  );

  // Resolve dest names and filter skips
  const transfers: {
    file: FileItem;
    destName: string;
    destFilePath: string;
    skip: boolean;
  }[] = [];

  for (const file of files) {
    const override = overrides?.get(file.path);
    if (override?.action === "skip") {
      results.push({ file, action: "skipped" });
      onFileComplete?.(file, results.length - 1, {
        file,
        action: "skipped",
      });
      continue;
    }

    const destName =
      override?.action === "auto"
        ? generateAutoName(file.name, existingNames)
        : override?.action === "rename" && override.newName
          ? override.newName
          : file.name;

    const destFilePath = joinPath(destPath, destName);
    existingNames.add(destName);

    transfers.push({ file, destName, destFilePath, skip: false });
  }

  // Process transfers in parallel batches
  for (let i = 0; i < transfers.length; i += MAX_CONCURRENT) {
    const batch = transfers.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (t, batchIdx) => {
        const globalIdx = i + batchIdx;
        onFileStart?.(t.file, globalIdx);

        // Same-provider local move: no TransferItem, instant
        if (
          isSameProvider &&
          source.type === "local" &&
          dest.type === "local" &&
          mode === "move"
        ) {
          await source.moveFile(t.file.path, t.destFilePath);
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
}
