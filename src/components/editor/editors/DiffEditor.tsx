import { MergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ArrowsLeftRightIcon, WarningIcon } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractError } from "@/lib/common/extractError";
import { languageFor } from "@/lib/editor/editorLanguage";
import { DEFAULT_EDITOR_THEME, editorThemes } from "@/lib/editor/editorThemes";
import { readLocalFile } from "@/lib/sftp/localFs";
import { useEditorStore } from "@/stores/editor/editorStore";
import { useThemeStore } from "@/stores/themeStore";

const DIFF_PREFIX = "diff:";

export function diffTabPath(path: string): string {
  return `${DIFF_PREFIX}${path}`;
}

export function isDiffTab(path: string): boolean {
  return path.startsWith(DIFF_PREFIX);
}

export function diffFilePath(path: string): string {
  return isDiffTab(path) ? path.slice(DIFF_PREFIX.length) : path;
}

interface GitConflictStages {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

const MAX_CONFLICT_LINES = 2000;

/** Read-only rendering of conflicted content with `<<<<<<<` markers tinted. */
function ConflictLines({ text }: { text: string }) {
  const lines = text.split("\n");
  const truncated = lines.length > MAX_CONFLICT_LINES;
  const shown = truncated ? lines.slice(0, MAX_CONFLICT_LINES) : lines;
  return (
    <div className="font-mono text-[12px] leading-5 whitespace-pre text-dark-200">
      {shown.map((line, _i) => {
        const trimmed = line.trimStart();
        let cls = "";
        if (trimmed.startsWith("<<<<<<<")) cls = "text-red-400 bg-red-400/5";
        else if (trimmed.startsWith("======="))
          cls = "text-amber-400 bg-amber-400/5";
        else if (trimmed.startsWith(">>>>>>>"))
          cls = "text-sky-400 bg-sky-400/5";
        return (
          <div key={line} className={cls}>
            {line || "\u00A0"}
          </div>
        );
      })}
      {truncated && (
        <div className="text-[11px] text-dark-500 py-2">
          Truncated &mdash; showing first {MAX_CONFLICT_LINES} lines.
        </div>
      )}
    </div>
  );
}

interface DiffEditorProps {
  path: string;
  name: string;
}

export default function DiffEditor({ path, name }: DiffEditorProps) {
  const localPath = useEditorStore((s) => s.localPath);
  const statusVersion = useEditorStore((s) => s.statusVersion);
  const bumpStatusVersion = useEditorStore((s) => s.bumpStatusVersion);
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastDocs = useRef<string | null>(null);
  const hasLoaded = useRef(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oldDoc, setOldDoc] = useState("");
  const [newDoc, setNewDoc] = useState<string | null>(null);
  const [conflict, setConflict] = useState<GitConflictStages | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const filePath = diffFilePath(path);
  const absPath =
    /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("/")
      ? filePath
      : `${(localPath ?? "")
          .replace(/\\/g, "/")
          .replace(/\/+$/, "")}/${filePath}`;

  useEffect(() => {
    let cancelled = false;
    // statusVersion intentionally triggers a reload when the workspace git
    // status changes (stage/commit/discard) — show fresh diffs automatically.
    void statusVersion;
    if (!localPath) {
      setInitialLoading(false);
      return;
    }
    const isFirst = !hasLoaded.current;
    if (isFirst) setInitialLoading(true);
    setError(null);
    void (async () => {
      let original: string | null = null;
      try {
        original = await invoke<string | null>("git_show_file", {
          root: localPath,
          path: absPath,
        });
      } catch (err) {
        if (!cancelled) setError(extractError(err, "Failed to load original"));
      }
      if (cancelled) return;
      let current: string | null = null;
      try {
        current = await readLocalFile(absPath);
      } catch {
        current = null; // deleted in the working tree
      }
      if (cancelled) return;
      let stages: GitConflictStages | null = null;
      try {
        stages = await invoke<GitConflictStages | null>("git_conflict_stages", {
          root: localPath,
          path: absPath,
        });
      } catch {
        stages = null; // not conflicted (or check failed) — show normal diff
      }
      if (cancelled) return;
      // Keep the state identity stable unless the conflict state actually
      // changed, so the merge view is not torn down on every status poll.
      setConflict((prev) =>
        (prev === null) === (stages === null) ? prev : stages,
      );
      hasLoaded.current = true;
      const key = `${original ?? "\u0000"}|${current ?? "\u0000"}|${
        stages !== null ? "C" : "-"
      }`;
      if (key === lastDocs.current) {
        if (isFirst) setInitialLoading(false);
        return;
      }
      lastDocs.current = key;
      setOldDoc(original ?? "");
      setNewDoc(current);
      if (isFirst) setInitialLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [absPath, localPath, statusVersion]);

  const editorTheme =
    editorThemes[currentTheme] ?? editorThemes[DEFAULT_EDITOR_THEME];

  const extensions = useMemo(() => {
    const list: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      editorTheme.theme,
    ];
    const lang = languageFor(filePath);
    if (lang) list.push(lang);
    return list;
  }, [editorTheme, filePath]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || newDoc === null || error || conflict !== null) return;
    const view = new MergeView({
      a: { doc: oldDoc, extensions },
      b: { doc: newDoc, extensions },
      parent: container,
      gutter: true,
      collapseUnchanged: { margin: 3 },
    });
    view.dom.classList.add("terra-diff-view");
    return () => {
      view.destroy();
    };
  }, [oldDoc, newDoc, error, extensions, conflict]);

  const resolveConflict = async (mode: "ours" | "theirs" | "both") => {
    if (!localPath || resolving) return;
    setResolving(true);
    setResolveError(null);
    try {
      await invoke("git_resolve_conflict", {
        root: localPath,
        path: absPath,
        mode,
      });
      bumpStatusVersion();
    } catch (err) {
      setResolveError(extractError(err, "Failed to resolve conflict"));
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-dark-950">
      <div className="flex items-center gap-1.5 px-3 h-8 border-b border-dark-800 shrink-0 bg-dark-900">
        {conflict ? (
          <WarningIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        ) : (
          <ArrowsLeftRightIcon className="w-3.5 h-3.5 text-primary-400 shrink-0" />
        )}
        <span
          className={`text-xs truncate min-w-0 ${
            conflict ? "text-amber-400" : "text-dark-200"
          }`}
        >
          {name}
        </span>
        {conflict ? (
          <>
            <span className="text-[10px] text-amber-400/70 shrink-0 ml-auto">
              Merge Conflict
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                title="Take the version from the current branch"
                aria-label="Accept the current branch version"
                disabled={resolving}
                onClick={() => void resolveConflict("ours")}
                className="h-6 px-1.5 rounded text-[10px] text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-40"
              >
                Accept Ours
              </button>
              <button
                type="button"
                title="Take the version from the other branch"
                aria-label="Accept the other branch version"
                disabled={resolving}
                onClick={() => void resolveConflict("theirs")}
                className="h-6 px-1.5 rounded text-[10px] text-sky-400 border border-sky-400/30 hover:bg-sky-400/10 disabled:opacity-40"
              >
                Accept Theirs
              </button>
              <button
                type="button"
                title="Keep both versions concatenated"
                aria-label="Accept both versions"
                disabled={resolving}
                onClick={() => void resolveConflict("both")}
                className="h-6 px-1.5 rounded text-[10px] text-dark-200 border border-dark-600 hover:bg-dark-700 disabled:opacity-40"
              >
                Accept Both
              </button>
            </div>
          </>
        ) : (
          <span className="text-[10px] text-dark-500 shrink-0 ml-auto">
            HEAD &rarr; Working Tree
          </span>
        )}
      </div>
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />
        {conflict && (
          <div className="absolute inset-0 overflow-auto bg-dark-950">
            {resolveError && (
              <div className="sticky top-0 px-3 py-2 text-[11px] text-red-400 border-b border-dark-800 bg-dark-950">
                {resolveError}
              </div>
            )}
            {newDoc === null ? (
              <div className="flex items-center justify-center h-full text-sm text-dark-400 px-6 text-center">
                File is deleted in the working tree. Use a resolution action
                above to restore one side.
              </div>
            ) : (
              <ConflictLines text={newDoc} />
            )}
          </div>
        )}
        {initialLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-dark-600 border-t-primary-400 rounded-full animate-spin" />
          </div>
        )}
        {!initialLoading && error && newDoc === null && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 px-6 text-center">
            {error}
          </div>
        )}
        {!initialLoading && !error && newDoc === null && !conflict && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-dark-400 px-6 text-center">
            This file was deleted in the working tree.
          </div>
        )}
      </div>
    </div>
  );
}
