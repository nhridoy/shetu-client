import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, readFile, stat, writeFile } from "@tauri-apps/plugin-fs";
import type { FileItem } from "@/types/sftp/sftpTypes";

export async function listLocalFiles(dirPath: string): Promise<FileItem[]> {
  const entries = await readDir(dirPath);
  const items: FileItem[] = [];

  for (const entry of entries) {
    const fullPath = dirPath.endsWith("/")
      ? `${dirPath}${entry.name}`
      : `${dirPath}/${entry.name}`;

    let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      fileStat = await stat(fullPath);
    } catch {
      // stat can fail on broken symlinks
    }

    const atime = (fileStat as unknown as { atime?: number } | null)?.atime;
    const accessedAt =
      atime != null
        ? new Date(atime).toISOString()
        : fileStat?.mtime
          ? new Date(fileStat.mtime).toISOString()
          : new Date().toISOString();

    items.push({
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory
        ? "directory"
        : entry.isSymlink
          ? "symlink"
          : "file",
      size: fileStat?.size ?? 0,
      permissions: "",
      owner: "",
      group: "",
      modifiedAt: fileStat?.mtime
        ? new Date(fileStat.mtime).toISOString()
        : new Date().toISOString(),
      accessedAt,
      isHidden: entry.name.startsWith("."),
    });
  }

  return items;
}

export async function listLocalFilesRecursive(
  dirPath: string,
  basePath?: string,
): Promise<FileItem[]> {
  const base = basePath ?? dirPath;
  const entries = await readDir(dirPath);
  const items: FileItem[] = [];
  const sep = dirPath.includes("\\") ? "\\" : "/";

  for (const entry of entries) {
    const fullPath = dirPath.endsWith(sep)
      ? `${dirPath}${entry.name}`
      : `${dirPath}${sep}${entry.name}`;

    // No stat here: readDir already gives isDirectory/isSymlink and the
    // recursive lister is only used for transfer expansion (size/mtime
    // aren't needed). This avoids one extra IPC call per file.
    items.push({
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory
        ? "directory"
        : entry.isSymlink
          ? "symlink"
          : "file",
      size: 0,
      permissions: "",
      owner: "",
      group: "",
      modifiedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      isHidden: entry.name.startsWith("."),
    });

    if (entry.isDirectory) {
      const subItems = await listLocalFilesRecursive(fullPath, base);
      items.push(...subItems);
    }
  }

  return items;
}

export async function isLocalDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory;
  } catch {
    return false;
  }
}

export async function readLocalFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return new TextDecoder().decode(content);
}

export async function readLocalFileBytes(
  filePath: string,
): Promise<Uint8Array> {
  return readFile(filePath);
}

export async function writeLocalFile(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, new TextEncoder().encode(content));
}

export async function writeLocalFileBytes(
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  await writeFile(filePath, data);
}

export async function createLocalDir(dirPath: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_mkdir", { path: dirPath });
}

export async function removeLocalFile(filePath: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_remove", { path: filePath, recursive: true });
}

export async function renameLocalFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_rename", { source: oldPath, dest: newPath });
}

export async function copyLocalFile(
  source: string,
  destination: string,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_copy", { source, dest: destination });
}

export async function moveLocalFile(
  source: string,
  destination: string,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_rename", { source, dest: destination });
}

export async function localFileExists(filePath: string): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("fs_exists", { path: filePath });
}

export async function getLocalFileStat(filePath: string) {
  return stat(filePath);
}

export async function openDirectoryPicker(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select Directory",
  });
  if (typeof selected === "string") return selected;
  return null;
}

export async function openFilePicker(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    title: "Select File",
  });
  if (typeof selected === "string") return selected;
  return null;
}

export async function saveFilePicker(
  defaultName?: string,
): Promise<string | null> {
  return save({
    defaultPath: defaultName,
    title: "Save File",
  });
}

export async function isSameVolume(
  path1: string,
  path2: string,
): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("is_same_volume", { path1, path2 });
}
