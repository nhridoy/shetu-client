import {
  copyLocalFile,
  createLocalDir,
  listLocalFiles,
  moveLocalFile,
  readLocalFileBytes,
  writeLocalFileBytes,
} from "@/lib/sftp/localFs";
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
    onFileProgress,
    onFileComplete,
  } = options;

  const results: TransferFileResult[] = [];
  const isSameProvider = source.id === dest.id;

  const existingNames = new Set(
    (await dest.listFiles(destPath).catch(() => [])).map((f) => f.name),
  );

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const override = overrides?.get(file.path);
    if (override?.action === "skip") {
      const result: TransferFileResult = {
        file,
        action: "skipped",
      };
      results.push(result);
      onFileComplete?.(file, i, result);
      continue;
    }

    onFileStart?.(file, i);

    const destName =
      override?.action === "auto"
        ? generateAutoName(file.name, existingNames)
        : override?.action === "rename" && override.newName
          ? override.newName
          : file.name;

    const destFilePath = joinPath(destPath, destName);

    try {
      if (isSameProvider && mode === "move") {
        if (source.type === "local" && dest.type === "local") {
          await source.moveFile(file.path, destFilePath);
        }
        const result: TransferFileResult = { file, action: "moved" };
        results.push(result);
        onFileComplete?.(file, i, result);
      } else if (
        isSameProvider &&
        mode === "copy" &&
        source.type === "local" &&
        dest.type === "local"
      ) {
        await dest.copyFile(file.path, destFilePath);
        const result: TransferFileResult = { file, action: "copied" };
        results.push(result);
        onFileComplete?.(file, i, result);
      } else if (
        source.type === "local" &&
        dest.type === "remote" &&
        dest.upload
      ) {
        // Stream local→remote via Rust upload (no full-file read)
        const transferId = crypto.randomUUID();
        await dest.upload(file.path, destFilePath, undefined, transferId);
        const result: TransferFileResult = { file, action: "copied" };
        results.push(result);
        onFileComplete?.(file, i, result);
      } else if (
        source.type === "remote" &&
        dest.type === "local" &&
        source.download
      ) {
        // Stream remote→local via Rust download (no full-file read)
        const transferId = crypto.randomUUID();
        await source.download(file.path, destFilePath, undefined, transferId);
        const result: TransferFileResult = { file, action: "copied" };
        results.push(result);
        onFileComplete?.(file, i, result);
      } else {
        const data = await source.readFile(file.path);
        await dest.writeFile(destFilePath, data, (loaded, total) => {
          onFileProgress?.(file, i, loaded, total);
        });
        const result: TransferFileResult = { file, action: "copied" };
        results.push(result);
        onFileComplete?.(file, i, result);
      }
      existingNames.add(destName);
    } catch (err) {
      const result: TransferFileResult = {
        file,
        action: "copied",
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(result);
      onFileComplete?.(file, i, result);
    }
  }

  return results;
}
