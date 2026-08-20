import { CircleNotchIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getEditorProvider } from "@/lib/editor/editorProvider";
import { getFileIcon } from "@/lib/sftp/fileHelpers";
import { listLocalFiles } from "@/lib/sftp/localFs";
import {
  collectWorkspaceFiles,
  WORKSPACE_FILE_LIMIT,
} from "@/lib/workspaces/workspaceFiles";
import { useEditorStore } from "@/stores/editor/editorStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

const MAX_RESULTS = 50;
const fileCache = new Map<string, Promise<FileItem[]>>();

function matchScore(item: FileItem, query: string): number {
  const name = item.name.toLowerCase();
  const path = item.path.toLowerCase();
  if (name === query) return 1000;
  if (name.startsWith(query)) return 900 - name.length;
  const ni = name.indexOf(query);
  if (ni >= 0) return 800 - ni;
  let i = 0;
  for (const ch of name) {
    if (ch === query[i]) i++;
    if (i === query.length) break;
  }
  if (i === query.length) return 400 - name.length;
  i = 0;
  for (const ch of path) {
    if (ch === query[i]) i++;
    if (i === query.length) break;
  }
  return i === query.length ? 100 - path.length : -1;
}

function relPath(rootPath: string, item: FileItem): string {
  const base = rootPath.replace(/[\\/]+$/, "");
  return item.path.slice(base.length).replace(/^[\\/]/, "") || ".";
}

export default function QuickOpen() {
  const connectionType = useEditorStore((s) => s.connectionType);
  const localPath = useEditorStore((s) => s.localPath);
  const explorerRootPath = useEditorStore((s) => s.explorerRootPath);
  const rootPath =
    connectionType === "local" ? (localPath ?? "") : (explorerRootPath ?? "");
  const close = useCallback(() => {
    useEditorStore.getState().setQuickOpenOpen(false);
  }, []);

  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollSelected = useCallback((el: HTMLLIElement | null) => {
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    let cached = fileCache.get(rootPath);
    if (!cached) {
      cached = collectWorkspaceFiles(rootPath, (path) => {
        const state = useEditorStore.getState();
        return state.connectionType === "host"
          ? getEditorProvider(state).listFiles(path)
          : listLocalFiles(path);
      });
      fileCache.set(rootPath, cached);
    }
    cached
      .then((list) => {
        if (!cancelled) {
          setFiles(list);
          setIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to index the workspace");
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const results = useMemo(() => {
    if (!files) return [];
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, MAX_RESULTS);
    return files
      .map((f) => ({ f, s: matchScore(f, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((r) => r.f);
  }, [files, query]);

  const openFile = (file: FileItem) => {
    useEditorStore.getState().openFile(file.path, file.name, true);
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) =>
        results.length === 0 ? 0 : Math.min(i + 1, results.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const file = results[index] ?? results[0];
      if (file) openFile(file);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-catcher, Esc closes for keyboard users
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="mx-auto mt-[12vh] w-[600px] max-w-[90vw] bg-dark-900 border border-dark-600 rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-dark-700">
          <MagnifyingGlassIcon
            className="w-4 h-4 text-dark-400 shrink-0"
            weight="bold"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name"
            aria-label="Quick open files"
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-white placeholder:text-dark-500"
          />
        </div>

        {error ? (
          <div className="px-4 py-3 text-xs text-red-400">{error}</div>
        ) : files === null ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-dark-400">
            <CircleNotchIcon className="w-3.5 h-3.5 animate-spin" />
            Indexing workspace...
          </div>
        ) : results.length === 0 ? (
          <div className="px-4 py-3 text-xs text-dark-500">
            No files match "{query.trim()}".
          </div>
        ) : (
          <ul className="max-h-[320px] overflow-y-auto py-1">
            {results.map((file, i) => {
              const selected = i === index;
              return (
                <li
                  key={file.path}
                  ref={selected ? scrollSelected : undefined}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={() => openFile(file)}
                  className={`flex items-center gap-2 px-3 h-8 cursor-pointer ${
                    selected ? "bg-dark-700/80" : "hover:bg-dark-700/40"
                  }`}
                >
                  {getFileIcon(file, 16)}
                  <span className="text-sm text-white truncate min-w-0">
                    {file.name}
                  </span>
                  <span className="ml-auto text-[11px] text-dark-400 truncate max-w-40">
                    {relPath(rootPath, file)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-between px-3 h-7 text-[11px] text-dark-500 border-t border-dark-700">
          <span>
            {files
              ? `${files.length} files (capped at ${WORKSPACE_FILE_LIMIT})`
              : ""}
          </span>
          <span>
            &uarr;&darr; navigate &middot; &#8617; open &middot; esc close
          </span>
        </div>
      </div>
    </div>
  );
}
