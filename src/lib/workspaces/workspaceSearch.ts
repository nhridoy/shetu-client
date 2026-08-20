import { listLocalFiles, readLocalFileBytes } from "@/lib/sftp/localFs";
import { collectWorkspaceFiles } from "@/lib/workspaces/workspaceFiles";
import type { FileItem } from "@/types/sftp/sftpTypes";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchMatch {
  line: number;
  text: string;
  column: number;
  length: number;
}

export interface FileSearchResult {
  file: FileItem;
  matches: SearchMatch[];
}

const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const SEARCH_MAX_MATCHES_PER_FILE = 200;
const SEARCH_MAX_TOTAL_MATCHES = 1500;
const SEARCH_CONCURRENCY = 12;

const fileListCache = new Map<string, Promise<FileItem[]>>();

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function relativeWorkspacePath(rootPath: string, filePath: string) {
  const base = rootPath.replace(/[\\/]+$/, "");
  return filePath.slice(base.length).replace(/^[\\/]/, "") || ".";
}

function globToRegex(glob: string): RegExp | null {
  const raw = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) return null;
  const hasSlash = raw.includes("/");
  let source = raw
    .replace(/([.+^${}()|[\]\\])/g, "\\$1")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  if (!hasSlash) {
    source = `(?:[^/]*/)*${source}`;
  }
  return new RegExp(`^${source}$`);
}

export function parseGlobList(input: string): RegExp[] {
  const globs = (input ?? "")
    .split(/[\n,]/)
    .map((g) => g.trim())
    .filter(Boolean);
  const regexps: RegExp[] = [];
  for (const glob of globs) {
    const regexp = globToRegex(glob.replace(/^!/, ""));
    if (regexp) regexps.push(regexp);
  }
  return regexps;
}

function compileQuery(query: string, options: SearchOptions): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  let source: string;
  if (options.regex) {
    try {
      new RegExp(trimmed);
      source = trimmed;
    } catch {
      source = escapeRegExp(trimmed);
    }
  } else {
    source = escapeRegExp(trimmed);
  }
  if (options.wholeWord) {
    source = `(?:\\b)(?:${source})(?:\\b)`;
  }
  return new RegExp(source, options.caseSensitive ? "g" : "gi");
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

async function matchesInFile(
  file: FileItem,
  regex: RegExp,
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<SearchMatch[]> {
  if (file.size === 0 || file.size > SEARCH_MAX_FILE_BYTES) return [];
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file.path);
  } catch {
    return [];
  }
  if (bytes.length === 0 || bytes.length > SEARCH_MAX_FILE_BYTES) return [];
  if (isBinary(bytes)) return [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const lines = text.split("\n");
  const matches: SearchMatch[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE) break;
    const lineText = lines[i].replace(/\r$/, "");
    for (const match of lineText.matchAll(regex)) {
      if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE) break;
      if (match.index === undefined) continue;
      matches.push({
        line: i + 1,
        text: lineText,
        column: match.index,
        length: match[0].length,
      });
    }
  }
  return matches;
}

export async function searchWorkspace(
  rootPath: string,
  query: string,
  options: SearchOptions,
  inFiles: string,
  excludeFiles: string,
  onProgress?: (results: FileSearchResult[], totalFiles: number) => void,
  readBytes: (path: string) => Promise<Uint8Array> = readLocalFileBytes,
  listDir: (path: string) => Promise<FileItem[]> = listLocalFiles,
): Promise<FileSearchResult[]> {
  const regex = compileQuery(query, options);
  if (!regex) return [];

  let cached = fileListCache.get(rootPath);
  if (!cached) {
    cached = collectWorkspaceFiles(rootPath, listDir);
    fileListCache.set(rootPath, cached);
  }
  const files = await cached;

  const include = {
    pos: parseGlobList(inFiles),
    neg: parseGlobList(
      (inFiles ?? "")
        .split(/[,]/)
        .map((g) => g.trim())
        .filter((g) => g.startsWith("!"))
        .join(","),
    ),
  };
  const exclude = parseGlobList(excludeFiles);
  const noIncludes = include.pos.length === 0;

  const wanted = (rel: string): boolean => {
    if (exclude.some((re) => re.test(rel))) return false;
    if (noIncludes) return true;
    return (
      include.pos.some((re) => re.test(rel)) &&
      !include.neg.some((re) => re.test(rel))
    );
  };

  const results: FileSearchResult[] = [];
  const stopping = { done: false };
  let next = 0;
  let totalMatches = 0;
  let pushed = 0;

  const flush = () => {
    if (pushed === 0) return;
    onProgress?.([...results], files.length);
    pushed = 0;
  };

  const worker = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (stopping.done || i >= files.length) return;
      const file = files[i];
      const rel = relativeWorkspacePath(rootPath, file.path);
      if (file.type !== "file" || !wanted(rel)) continue;
      let matches: SearchMatch[];
      try {
        matches = await matchesInFile(file, regex, readBytes);
      } catch {
        matches = [];
      }
      const remaining = SEARCH_MAX_TOTAL_MATCHES - totalMatches;
      if (matches.length === 0 || remaining <= 0) continue;
      if (matches.length > remaining) {
        matches = matches.slice(0, remaining);
      }
      totalMatches += matches.length;
      results.push({ file, matches });
      pushed += 1;
      if (totalMatches >= SEARCH_MAX_TOTAL_MATCHES) {
        stopping.done = true;
        break;
      }
      if (pushed >= 12) flush();
    }
  };

  await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, () => worker()));

  results.sort((a, b) => a.file.path.localeCompare(b.file.path));
  onProgress?.(results, files.length);
  return results;
}
