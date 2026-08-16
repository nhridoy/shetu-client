import type { FileItem } from "@/types/sftp/sftpTypes";
import type { ProgressCallback } from "./fileTransfer";

export interface RemoteFileProvider {
  type: "remote";
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
  delete(path: string, recursive?: boolean): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  stat(path: string): Promise<FileItem>;
  search(path: string, query: string): Promise<FileItem[]>;
  download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void>;
  upload(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void>;
}

interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  atime: number;
  symlink_target: string | null;
}

function modeToPermissions(mode: number): string {
  const bits = mode & 0o7777;
  const rwx = (bit: number, has: number, upper: string) =>
    bit & has ? upper.toLowerCase() : "-";
  return [
    rwx(bits, 0o400, "R"),
    rwx(bits, 0o200, "W"),
    rwx(bits, 0o100, "X"),
    rwx(bits, 0o040, "R"),
    rwx(bits, 0o020, "W"),
    rwx(bits, 0o010, "X"),
    rwx(bits, 0o004, "R"),
    rwx(bits, 0o002, "W"),
    rwx(bits, 0o001, "X"),
  ].join("");
}

function sftpEntryToFileItem(e: SftpEntry): FileItem {
  return {
    name: e.name,
    path: e.path,
    type: e.is_dir ? "directory" : e.is_symlink ? "symlink" : "file",
    size: e.size,
    permissions: modeToPermissions(e.mode),
    owner: String(e.uid),
    group: String(e.gid),
    modifiedAt: new Date(e.mtime * 1000).toISOString(),
    isHidden: e.name.startsWith("."),
  };
}

export class RemoteFileProviderImpl implements RemoteFileProvider {
  type = "remote" as const;
  private invoke: typeof import("@tauri-apps/api/core").invoke | null = null;

  constructor(
    public id: string,
    private sessionId: string,
  ) {}

  private async getInvoke() {
    if (!this.invoke) {
      const mod = await import("@tauri-apps/api/core");
      this.invoke = mod.invoke;
    }
    return this.invoke;
  }

  async listFiles(path: string): Promise<FileItem[]> {
    const invoke = await this.getInvoke();
    const entries = await invoke<SftpEntry[]>("sftp_list", {
      sessionId: this.sessionId,
      path,
    });
    return entries.map(sftpEntryToFileItem);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const invoke = await this.getInvoke();
    const chunkSize = 64 * 1024;
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (true) {
      const chunk = await invoke<number[]>("sftp_read", {
        sessionId: this.sessionId,
        path,
        offset,
        len: chunkSize,
      });
      if (chunk.length === 0) break;
      chunks.push(new Uint8Array(chunk));
      offset += chunk.length;
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }
    return result;
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const invoke = await this.getInvoke();
    const chunkSize = 64 * 1024;
    const total = data.length;

    for (let offset = 0; offset < total; offset += chunkSize) {
      const chunk = data.slice(offset, offset + chunkSize);
      await invoke("sftp_write", {
        sessionId: this.sessionId,
        path,
        data: Array.from(chunk),
        offset,
      });
      onProgress?.(Math.min(offset + chunkSize, total), total);
    }
  }

  async moveFile(source: string, dest: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_rename", {
      sessionId: this.sessionId,
      oldPath: source,
      newPath: dest,
    });
  }

  async copyFile(source: string, dest: string): Promise<void> {
    const data = await this.readFile(source);
    await this.writeFile(dest, data);
  }

  async delete(path: string, recursive = true): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_delete", {
      sessionId: this.sessionId,
      path,
      recursive,
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_mkdir", { sessionId: this.sessionId, path });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_chmod", { sessionId: this.sessionId, path, mode });
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_chown", { sessionId: this.sessionId, path, uid, gid });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke("sftp_symlink", {
      sessionId: this.sessionId,
      target,
      linkPath,
    });
  }

  async readlink(path: string): Promise<string> {
    const invoke = await this.getInvoke();
    return invoke("sftp_readlink", { sessionId: this.sessionId, path });
  }

  async stat(path: string): Promise<FileItem> {
    const invoke = await this.getInvoke();
    const e = await invoke<SftpEntry>("sftp_stat", {
      sessionId: this.sessionId,
      path,
    });
    return sftpEntryToFileItem(e);
  }

  async search(path: string, query: string): Promise<FileItem[]> {
    const invoke = await this.getInvoke();
    const entries = await invoke<SftpEntry[]>("sftp_search", {
      sessionId: this.sessionId,
      path,
      query,
    });
    return entries.map(sftpEntryToFileItem);
  }

  async download(
    remotePath: string,
    localPath: string,
    _onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void> {
    const invoke = await this.getInvoke();
    const id = transferId ?? crypto.randomUUID();

    await invoke("sftp_download", {
      sessionId: this.sessionId,
      remotePath,
      localPath,
      transferId: id,
    });
  }

  async upload(
    localPath: string,
    remotePath: string,
    _onProgress?: ProgressCallback,
    transferId?: string,
  ): Promise<void> {
    const invoke = await this.getInvoke();
    const id = transferId ?? crypto.randomUUID();

    await invoke("sftp_upload", {
      sessionId: this.sessionId,
      localPath,
      remotePath,
      transferId: id,
    });
  }
}
