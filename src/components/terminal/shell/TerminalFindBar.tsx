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

/** Find bar over a terminal pane, driving xterm's search add-on. */
export default function TerminalFindBar({
  search,
  onClose,
}: {
  search: FindTarget;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(lastQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number }>();
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const sub = search.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex, count: e.resultCount }),
    );
    return () => sub.dispose();
  }, [search]);

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive,
    wholeWord,
    regex,
    incremental,
    decorations: DECORATIONS,
  });

  /** Runs one search; a bad regex shows "Invalid pattern" instead of throwing. */
  const run = (direction: "next" | "previous", incremental: boolean) => {
    if (!query) return;
    try {
      if (regex) new RegExp(query);
      if (direction === "next") search.findNext(query, options(incremental));
      else search.findPrevious(query, options(false));
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
      return;
    }
    run("next", true);
  }, [query, caseSensitive, wholeWord, regex, search]);

  const close = () => {
    search.clearDecorations();
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
          : `${results.count} matches`;

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
    <div
      role="search"
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
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
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
