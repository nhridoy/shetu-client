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

export type FileSortField =
  | "name"
  | "size"
  | "type"
  | "permissions"
  | "modifiedAt"
  | "accessedAt";
export type FileSortDirection = "asc" | "desc";
export type FileViewMode = "list" | "grid";
