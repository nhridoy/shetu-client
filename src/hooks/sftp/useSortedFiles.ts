import { useMemo } from "react";
import type {
  FileItem,
  FileSortDirection,
  FileSortField,
} from "@/types/sftp/sftpTypes";

interface UseSortedFilesOptions {
  files: FileItem[];
  showHidden: boolean;
  searchQuery: string;
  sortField: FileSortField;
  sortDirection: FileSortDirection;
}

export function useSortedFiles({
  files,
  showHidden,
  searchQuery,
  sortField,
  sortDirection,
}: UseSortedFilesOptions) {
  return useMemo(() => {
    return [...files]
      .filter(
        (f) =>
          (showHidden || !f.isHidden) &&
          (searchQuery === "" ||
            f.name.toLowerCase().includes(searchQuery.toLowerCase())),
      )
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        let cmp = 0;
        if (sortField === "name") cmp = a.name.localeCompare(b.name);
        else if (sortField === "size") cmp = a.size - b.size;
        else if (sortField === "type") {
          const rank = (t: string) =>
            t === "directory" ? 0 : t === "symlink" ? 1 : 2;
          cmp = rank(a.type) - rank(b.type) || a.name.localeCompare(b.name);
        } else if (sortField === "permissions")
          cmp = a.permissions.localeCompare(b.permissions);
        else if (sortField === "modifiedAt")
          cmp =
            new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
        else if (sortField === "accessedAt")
          cmp =
            new Date(a.accessedAt ?? a.modifiedAt).getTime() -
            new Date(b.accessedAt ?? b.modifiedAt).getTime();
        return sortDirection === "asc" ? cmp : -cmp;
      });
  }, [files, showHidden, searchQuery, sortField, sortDirection]);
}
