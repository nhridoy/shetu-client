import type { FileItem } from "@/types/sftp/sftpTypes";
import type { ProgressCallback } from "./fileTransfer";
import { COMPARE_CAP } from "./folderCompare";
import { RemoteFileProviderImpl } from "./remoteFs";

/** One listed object or folder, as Rust's `storage_list` returns it. */
interface StorageEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

const toItem = (e: StorageEntry): FileItem => {
  const at = new Date(e.mtime * 1000).toISOString();
  return {
    name: e.name,
    path: e.path,
    type: e.isDir ? "directory" : "file",
    size: e.size,
    permissions: "",
    owner: "",
    group: "",
    modifiedAt: at,
    accessedAt: at,
    isHidden: e.name.startsWith("."),
  };
};

const unsupported = (what: string) =>
  Promise.reject(new Error(`${what} isn't supported in a bucket`));

/**
 * An S3 bucket pane. It is a "remote" provider whose session id is its pane id, so transfers,
 * drag and drop and compare treat it like an SFTP pane; Rust resolves the id to the bucket.
 */
export class StorageFileProvider extends RemoteFileProviderImpl {
  /** Set after connect: a bucket (S3) or a server (WebDAV). */
  kind: "s3" | "webdav" = "s3";

  private async call<T>(cmd: string, args: Record<string, unknown> = {}) {
    const { invoke } = await import("@tauri-apps/api/core");
    // The account goes with every call: Rust refuses it if the pane has since reconnected to
    // another bucket, so nothing in flight lands there.
    return invoke<T>(cmd, {
      sessionId: this.getSessionId(),
      accountId: this.id.slice("storage:".length),
      ...args,
    });
  }

  /** `(size, mtime)` of an object, or null when no object has that name (a folder). */
  async statTimes(
    path: string,
  ): Promise<{ size: number; mtime: number } | null> {
    const found = await this.call<[number, number] | null>("storage_stat", {
      path,
    });
    return found ? { size: found[0], mtime: found[1] } : null;
  }

  async listFiles(path: string): Promise<FileItem[]> {
    return (await this.call<StorageEntry[]>("storage_list", { path })).map(
      toItem,
    );
  }

  async listFilesRecursive(path: string): Promise<FileItem[]> {
    return (
      await this.call<StorageEntry[]>("storage_list_recursive", {
        path,
        cap: COMPARE_CAP,
      })
    ).map(toItem);
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await this.statTimes(path)) === null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.call<number[]>("storage_read", { path }));
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    _onProgress?: ProgressCallback,
  ): Promise<void> {
    await this.call("storage_write", { path, data: Array.from(data) });
  }

  async moveFile(source: string, dest: string): Promise<void> {
    await this.call("storage_rename", {
      from: source,
      to: dest,
      isDir: await this.isDirectory(source),
    });
  }

  copyFile(_source: string, _dest: string): Promise<void> {
    return Promise.reject(
      new Error("Copy within a bucket isn't supported; drag to another pane"),
    );
  }

  async delete(path: string): Promise<void> {
    await this.call("storage_delete", {
      path,
      isDir: await this.isDirectory(path),
    });
  }

  async removeFile(path: string): Promise<void> {
    await this.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    if (await this.statTimes(path)) return true;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (await this.listFiles(parent)).some((i) => i.name === name);
  }

  async mkdir(path: string): Promise<void> {
    await this.call("storage_mkdir", { path });
  }

  async mkdirAll(paths: string[]): Promise<void> {
    for (const path of paths.filter(Boolean)) await this.mkdir(path);
  }

  async stat(path: string): Promise<FileItem> {
    const times = await this.statTimes(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    return toItem({
      name,
      path,
      isDir: times === null,
      size: times?.size ?? 0,
      mtime: times?.mtime ?? 0,
    });
  }

  chmod(_path: string, _mode: number): Promise<void> {
    return unsupported("Permissions");
  }

  chown(_path: string, _uid: number, _gid: number): Promise<void> {
    return unsupported("Owners");
  }

  symlink(_target: string, _linkPath: string): Promise<void> {
    return unsupported("Links");
  }

  readlink(_path: string): Promise<string> {
    return unsupported("Links");
  }

  search(_path: string, _query: string): Promise<FileItem[]> {
    return unsupported("Search");
  }
}

/** Renaming a bucket folder copies and deletes every object in it: ask first, with the count. */
export async function confirmFolderRename(
  provider: StorageFileProvider,
  path: string,
  name: string,
  ask: (message: string) => boolean = (m) => window.confirm(m),
): Promise<boolean> {
  const count = (await provider.listFilesRecursive(path)).length;
  return ask(
    `Rename "${name}" and the ${count} items in it? Each object is copied to the new name, then deleted.`,
  );
}

/** Only a bucket folder rename copies every object (a WebDAV server moves it in one go). */
export function needsRenameConfirm(
  provider: StorageFileProvider,
  file: FileItem,
): boolean {
  return provider.kind === "s3" && file.type === "directory";
}
