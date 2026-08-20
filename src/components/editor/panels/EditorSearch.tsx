import {
  ArrowsDownUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CircleNotchIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { extractError } from "@/lib/common/extractError";
import { getEditorProvider } from "@/lib/editor/editorProvider";
import { getFileIcon } from "@/lib/sftp/fileHelpers";
import {
  type FileSearchResult,
  relativeWorkspacePath,
  type SearchMatch,
  type SearchOptions,
  searchWorkspace,
} from "@/lib/workspaces/workspaceSearch";
import { useEditorStore } from "@/stores/editor/editorStore";

const OPTION_TOGGLES: {
  key: keyof SearchOptions;
  label: string;
  title: string;
}[] = [
  { key: "caseSensitive", label: "Aa", title: "Match Case" },
  { key: "wholeWord", label: "ab", title: "Match Whole Word" },
  { key: "regex", label: ".*", title: "Use Regular Expression" },
];

function OptionToggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`w-5 h-5 flex items-center justify-center rounded text-[10px] font-semibold transition-colors ${
        active
          ? "text-primary-400"
          : "text-dark-400 hover:text-white hover:bg-dark-700"
      }`}
    >
      {children}
    </button>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(label === "In files");

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-dark-300 hover:text-white"
      >
        {open ? (
          <CaretDownIcon className="w-3 h-3" />
        ) : (
          <CaretRightIcon className="w-3 h-3" />
        )}
        {label}
      </button>
      {open && (
        <div className="flex items-center gap-0.5 mt-1">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            className="flex-1 min-w-0 h-7 bg-dark-950 border border-dark-700 focus:border-primary-500 rounded px-2 text-xs text-white placeholder:text-dark-500 outline-none"
          />
          {value && (
            <button
              type="button"
              title="Clear"
              aria-label={`Clear ${label}`}
              onClick={() => onChange("")}
              className="p-1 text-dark-500 hover:text-white"
            >
              <XIcon className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HighlightLine({
  text,
  spans,
}: {
  text: string;
  spans: SearchMatch[];
}) {
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.column > cursor) {
      segments.push(text.slice(cursor, span.column));
    }
    segments.push(
      <mark
        key={span.column}
        className="bg-yellow-300/70 text-dark-950 rounded-[2px] px-px"
      >
        {text.slice(span.column, span.column + span.length)}
      </mark>,
    );
    cursor = span.column + span.length;
    if (cursor >= text.length) break;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return <>{segments}</>;
}

function FileResultGroup({
  rootPath,
  result,
  collapsed,
  onToggle,
  onOpen,
}: {
  rootPath: string;
  result: FileSearchResult;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (match: SearchMatch) => void;
}) {
  const { matches } = result;

  const byLine = new Map<number, SearchMatch[]>();
  for (const match of matches) {
    const list = byLine.get(match.line) ?? [];
    list.push(match);
    byLine.set(match.line, list);
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 h-7 hover:bg-dark-800 text-left"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <CaretRightIcon className="w-3 h-3 text-dark-400 shrink-0" />
        ) : (
          <CaretDownIcon className="w-3 h-3 text-dark-400 shrink-0" />
        )}
        {getFileIcon(result.file, 14)}
        <span className="text-[11px] text-dark-200 truncate min-w-0">
          {relativeWorkspacePath(rootPath, result.file.path)}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-primary-400">
          {matches.length}
        </span>
      </button>
      {!collapsed && (
        <div>
          {[...byLine.entries()].map(([line, spans]) => (
            <button
              key={line}
              type="button"
              onClick={() => onOpen(spans[0])}
              className="w-full flex items-center gap-2 px-2 pl-8 h-6 hover:bg-dark-800/70 text-left font-mono"
              title={`Open ${result.file.name}:${line}`}
            >
              <span className="w-8 text-right shrink-0 text-[10px] text-dark-400 select-none">
                {line}
              </span>
              <span className="text-[11px] text-dark-300 truncate min-w-0">
                <HighlightLine text={spans[0].text} spans={spans} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EditorSearch() {
  const connectionType = useEditorStore((s) => s.connectionType);
  const localPath = useEditorStore((s) => s.localPath);
  const explorerRootPath = useEditorStore((s) => s.explorerRootPath);
  const rootPath =
    connectionType === "local" ? (localPath ?? "") : (explorerRootPath ?? "");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [inFiles, setInFiles] = useState("");
  const [excludeFiles, setExcludeFiles] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });

  const toggleOption = (key: keyof SearchOptions) =>
    setOptions((o) => ({ ...o, [key]: !o[key] }));

  const runSearch = () => {
    if (!rootPath || !query.trim()) return;
    const id = ++requestIdRef.current;
    setSearching(true);
    setSearchError(null);
    setResults(null);
    setCollapsed(new Set());
    const state = useEditorStore.getState();
    const provider =
      state.connectionType === "host" ? getEditorProvider(state) : null;
    searchWorkspace(
      rootPath,
      query,
      options,
      inFiles,
      excludeFiles,
      (partial) => {
        if (id === requestIdRef.current) setResults(partial);
      },
      provider ? (path) => provider.readFile(path) : undefined,
      provider ? (path) => provider.listFiles(path) : undefined,
    )
      .then((full) => {
        if (id === requestIdRef.current) {
          setResults(full);
          setSearching(false);
        }
      })
      .catch((err) => {
        if (id === requestIdRef.current) {
          setSearchError(extractError(err, "Search failed"));
          setSearching(false);
        }
      });
  };

  const totalMatches = results?.reduce((n, r) => n + r.matches.length, 0) ?? 0;

  const handleOpen = (match: SearchMatch, result: FileSearchResult) => {
    useEditorStore
      .getState()
      .openFile(result.file.path, result.file.name, true);
    useEditorStore.getState().setRevealRequest({
      path: result.file.path,
      line: match.line,
      column: match.column,
    });
  };

  const toggleAll = () => {
    if (!results) return;
    setCollapsed((current) =>
      current.size === results.length
        ? new Set()
        : new Set(results.map((r) => r.file.path)),
    );
  };

  return (
    <div className="w-full h-full flex flex-col bg-dark-900 border-r border-dark-800 min-h-0">
      {/* Panel header */}
      <div className="flex items-center gap-1.5 pl-3 pr-2 h-8 border-b border-dark-800 shrink-0">
        <MagnifyingGlassIcon
          className="w-3.5 h-3.5 text-dark-400"
          weight="bold"
        />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dark-300">
          Search
        </span>
        {results && !searching && (
          <span className="ml-auto text-[10px] text-dark-400 truncate">
            {totalMatches} {totalMatches === 1 ? "result" : "results"} in{" "}
            {results.length} {results.length === 1 ? "file" : "files"}
          </span>
        )}
      </div>

      {/* Search inputs */}
      <div className="px-2 py-2 space-y-1.5 shrink-0 min-w-0">
        <div className="flex items-center gap-0.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search across files"
            aria-label="Search code"
            className="flex-1 min-w-0 h-7 bg-dark-950 border border-dark-700 focus:border-primary-500 rounded px-2 text-xs text-white placeholder:text-dark-500 outline-none"
          />
          {query && (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                requestIdRef.current += 1;
                setQuery("");
                setResults(null);
                setSearching(false);
                setSearchError(null);
              }}
              className="p-1 text-dark-500 hover:text-white"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
          {OPTION_TOGGLES.map(({ key, label, title }) => (
            <OptionToggle
              key={key}
              active={options[key]}
              title={title}
              onClick={() => toggleOption(key)}
            >
              {label}
            </OptionToggle>
          ))}
        </div>

        {/* Replace row */}
        <div className="flex items-center gap-0.5 ml-4">
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="Replace with"
            aria-label="Replace text"
            disabled={!showReplace}
            className={`flex-1 min-w-0 h-7 bg-dark-950 border border-dark-700 focus:border-primary-500 rounded px-2 text-xs text-white placeholder:text-dark-500 outline-none ${
              showReplace ? "" : "opacity-50"
            }`}
          />
          <button
            type="button"
            title="Toggle Replace"
            aria-pressed={showReplace}
            onClick={() => setShowReplace((v) => !v)}
            className="p-1 text-dark-500 hover:text-white"
          >
            <ArrowsDownUpIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-0.5">
          <span className="flex-1" />
          <button
            type="button"
            title="Search filters"
            aria-pressed={showFilter}
            onClick={() => setShowFilter((v) => !v)}
            className={`p-1 rounded transition-colors ${
              showFilter
                ? "text-primary-400 bg-dark-700"
                : "text-dark-400 hover:text-white hover:bg-dark-700"
            }`}
          >
            <SlidersHorizontalIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {showFilter && (
          <div className="flex flex-col gap-1.5 border-t border-dark-800 pt-1.5">
            <FilterInput
              label="In files"
              value={inFiles}
              onChange={setInFiles}
              placeholder="*.tsx, !node_modules/**"
            />
            <FilterInput
              label="Files to exclude"
              value={excludeFiles}
              onChange={setExcludeFiles}
              placeholder="'out' folder, *.spec.ts"
            />
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {searchError ? (
          <div className="px-3 py-2 text-red-400">{searchError}</div>
        ) : searching && results === null ? (
          <div className="flex items-center gap-2 px-3 py-2 text-dark-400">
            <CircleNotchIcon className="w-3.5 h-3.5 animate-spin" />
            Searching across workspace...
          </div>
        ) : results && results.length === 0 ? (
          <div className="px-3 py-2 text-dark-500">
            No results found for "{query.trim()}".
          </div>
        ) : results ? (
          <div className="pb-2">
            {searching && (
              <div className="flex items-center gap-2 px-3 py-1 text-dark-400">
                <CircleNotchIcon className="w-3 h-3 animate-spin" />
                <span className="text-[11px]">Searching...</span>
              </div>
            )}
            {results.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-dark-400 hover:text-white"
              >
                {collapsed.size === results.length ? (
                  <CaretRightIcon className="w-3 h-3" />
                ) : (
                  <CaretDownIcon className="w-3 h-3" />
                )}
                {collapsed.size === results.length
                  ? "Expand All"
                  : "Collapse All"}
              </button>
            )}
            {results.map((result) => (
              <FileResultGroup
                key={result.file.path}
                rootPath={rootPath}
                result={result}
                collapsed={collapsed.has(result.file.path)}
                onToggle={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(result.file.path)) {
                      next.delete(result.file.path);
                    } else {
                      next.add(result.file.path);
                    }
                    return next;
                  })
                }
                onOpen={(match) => handleOpen(match, result)}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-dark-500">
            Type a query and press Enter to search across your workspace.
          </div>
        )}
      </div>
    </div>
  );
}
