import type { FileProvider } from "@/lib/sftp/fileTransfer";
import { listLocalFiles } from "@/lib/sftp/localFs";
import type { FileItem } from "@/types/sftp/sftpTypes";

export const WORKSPACE_MAX_DEPTH = 12;
export const WORKSPACE_FILE_LIMIT = 2000;

const IGNORED_DIRS = new Set([
  ".git",
  ".vite",
  ".next",
  ".cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
]);

export async function collectWorkspaceFiles(
  rootPath: string,
  listDir: (path: string) => Promise<FileItem[]> = listLocalFiles,
): Promise<FileItem[]> {
  const out: FileItem[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_MAX_DEPTH || out.length >= WORKSPACE_FILE_LIMIT) {
      return;
    }
    let items: FileItem[];
    try {
      items = await listDir(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= WORKSPACE_FILE_LIMIT) return;
      if (item.type === "directory") {
        if (IGNORED_DIRS.has(item.name)) continue;
        await walk(item.path, depth + 1);
      } else if (item.type === "file") {
        out.push(item);
      }
    }
  };

  await walk(rootPath, 0);
  return out;
}

export function collectProviderWorkspaceFiles(
  provider: FileProvider,
  rootPath: string,
): Promise<FileItem[]> {
  return collectWorkspaceFiles(rootPath, (path) => provider.listFiles(path));
}
