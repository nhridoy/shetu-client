import {
  ArrowDownIcon,
  ArrowUpIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

export type FindTarget = Pick<
  SearchAddon,
  "findNext" | "findPrevious" | "clearDecorations"
> & {
  onDidChangeResults: (
    listener: (e: { resultIndex: number; resultCount: number }) => void,
  ) => { dispose: () => void };
};

const DECORATIONS = {
  matchBackground: "#f59e0b55",
  matchOverviewRuler: "#f59e0b55",
  activeMatchBackground: "#f59e0b",
  activeMatchColorOverviewRuler: "#f59e0b",
};

// Reopening the bar keeps the last search.
let lastQuery = "";

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The search term sent to the add-on. Whole word is done here with \b, because
 * add-on 0.16.0 gives up on a line after one non-word match ("foobar foo").
 */
export function searchTerm(query: string, regex: boolean, wholeWord: boolean) {
  if (!wholeWord) return query;
  const core = regex ? query : escapeRegExp(query);
  // A \b next to a non-word character would stop "-v" from ever matching.
  const start = regex || /^\w/.test(query) ? "\\b" : "";
  const end = regex || /\w$/.test(query) ? "\\b" : "";
  return `${start}(?:${core})${end}`;
}

/** Find bar over a terminal pane, driving xterm's search add-on. */
export default function TerminalFindBar({
  search,
  onClose,
  clearSelection,
  opened = 0,
}: {
  search: FindTarget;
  onClose: () => void;
  /** Searching selects the active match; leaving search must unselect it. */
  clearSelection: () => void;
  /** Bumped each time find is asked for, so an open bar takes focus again. */
  opened?: number;
}) {
  const [query, setQuery] = useState(lastQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number }>();
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // True once a search may have selected a match; only that selection is ours to clear.
  const selected = useRef(false);
  const clearOurSelection = () => {
    if (selected.current) clearSelection();
    selected.current = false;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: opened is the trigger
  useEffect(() => {
    // select() alone doesn't move focus in every webview.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [opened]);

  useEffect(() => {
    const sub = search.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex, count: e.resultCount }),
    );
    return () => sub.dispose();
  }, [search]);

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive,
    wholeWord: false,
    regex: regex || wholeWord,
    incremental,
    decorations: DECORATIONS,
  });

  /** Runs one search; a bad regex shows "Invalid pattern" instead of throwing. */
  const run = (direction: "next" | "previous", incremental: boolean) => {
    if (!query) return;
    const term = searchTerm(query, regex, wholeWord);
    try {
      if (regex || wholeWord) new RegExp(term);
      selected.current = true;
      if (direction === "next") search.findNext(term, options(incremental));
      else search.findPrevious(term, options(false));
      setInvalid(false);
    } catch {
      setInvalid(true);
      setResults(undefined);
      search.clearDecorations();
    }
  };

  // Live search whenever the text or a toggle changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run reads these values
  useEffect(() => {
    lastQuery = query;
    if (!query) {
      setInvalid(false);
      setResults(undefined);
      search.clearDecorations();
      clearOurSelection();
      return;
    }
    run("next", true);
  }, [query, caseSensitive, wholeWord, regex, search]);

  const close = () => {
    search.clearDecorations();
    clearOurSelection();
    onClose();
  };

  const status = invalid
    ? "Invalid pattern"
    : !query || !results
      ? ""
      : results.count === 0
        ? "No results"
        : results.index >= 0
          ? `${results.index + 1} of ${results.count}`
          : // The add-on stops counting at its highlight limit.
            `${results.count}${results.count >= 1000 ? "+" : ""} matches`;

  const toggle = (
    label: string,
    text: string,
    on: boolean,
    set: (v: boolean) => void,
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-pressed={on}
      className={on ? "bg-primary-600/30 text-white" : "text-dark-400"}
      onClick={() => set(!on)}
    >
      <span className="font-mono text-[11px]">{text}</span>
    </Button>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: older WebKitGTK webviews lack <search>
    <div
      role="search"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-dark-700 bg-dark-900/95 px-2 py-1 shadow-lg"
      aria-label="Find in terminal"
    >
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-400" />
      <input
        ref={inputRef}
        value={query}
        aria-label="Find"
        placeholder="Find"
        aria-invalid={invalid}
        className="h-6 w-44 bg-transparent text-sm text-white outline-none placeholder:text-dark-500"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(e.shiftKey ? "previous" : "next", false);
          }
        }}
      />
      <span
        aria-live="polite"
        className={`min-w-16 text-right text-xs ${invalid ? "text-red-400" : "text-dark-400"}`}
      >
        {status}
      </span>
      {toggle("Match case", "Aa", caseSensitive, setCaseSensitive)}
      {toggle("Whole word", "W", wholeWord, setWholeWord)}
      {toggle("Use regex", ".*", regex, setRegex)}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        onClick={() => run("previous", false)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        onClick={() => run("next", false)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close find"
        onClick={close}
      >
        <XIcon />
      </Button>
    </div>
  );
}
