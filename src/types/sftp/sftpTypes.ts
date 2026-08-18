export interface FileItem {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedAt: string;
  accessedAt?: string;
  isHidden: boolean;
}

export interface TransferItem {
  id: string;
  fileName: string;
  localPath?: string;
  remotePath?: string;
  direction: "upload" | "download";
  status: "pending" | "active" | "complete" | "error";
  progress: number;
  size: number;
  transferred: number;
  speed?: number;
  error?: string;
}

export type FileSortField =
  | "name"
  | "size"
  | "type"
  | "permissions"
  | "modifiedAt"
  | "accessedAt";
export type FileSortDirection = "asc" | "desc";
export type FileViewMode = "list" | "grid";
