import { type ReactNode, useEffect, useState } from "react";

const HOST = "deploy@prod-eu-1";

type Line = { prompt: "local" | "remote"; cmd: string } | { out: ReactNode };

const Dim = ({ children }: { children: ReactNode }) => (
  <span className="text-dark-500">{children}</span>
);

const Active = () => <span className="text-green-400">active</span>;

const LINES: Line[] = [
  { prompt: "local", cmd: `ssh ${HOST}` },
  { out: "Welcome to Ubuntu 24.04.1 LTS" },
  { out: <Dim>Last login: Thu Nov 13 09:12:44 2026 from 10.0.4.2</Dim> },
  { prompt: "remote", cmd: "uptime -p" },
  { out: "up 41 days, 3 hours, 7 minutes" },
  { prompt: "remote", cmd: "systemctl is-active nginx postgresql" },
  { out: <Active /> },
  { out: <Active /> },
];

const Cursor = () => (
  <span className="inline-block w-2 h-4 align-[-2px] bg-primary-400 motion-safe:animate-caret-blink" />
);

const Prompt = ({ kind }: { kind: "local" | "remote" }) =>
  kind === "local" ? (
    <span className="text-primary-400">~ $ </span>
  ) : (
    <>
      <span className="text-green-400">{HOST}</span>:
      <span className="text-primary-400">~</span>${" "}
    </>
  );

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Decorative looping SSH session for the auth brand panel. */
export default function TerminalDemo() {
  // line = lines fully shown; chars = typed chars of the current cmd line
  const [{ line, chars }, setPos] = useState(() => ({
    line: reducedMotion() ? LINES.length : 0,
    chars: 0,
  }));

  useEffect(() => {
    if (reducedMotion()) return;
    const cur = LINES[line];
    const typing = cur && "cmd" in cur && chars < cur.cmd.length;
    const delay = !cur ? 4000 : typing ? 45 : "cmd" in cur ? 400 : 120;
    const t = setTimeout(() => {
      setPos(
        !cur
          ? { line: 0, chars: 0 }
          : typing
            ? { line, chars: chars + 1 }
            : { line: line + 1, chars: 0 },
      );
    }, delay);
    return () => clearTimeout(t);
  }, [line, chars]);

  const cur = LINES[line];
  const done = line >= LINES.length;
  // Like a real terminal, the title follows the shell you're in.
  const title = line > 0 ? `${HOST}: ~` : "zsh";

  return (
    <div
      aria-hidden="true"
      className="rounded-xl border border-dark-700 bg-dark-950/85 overflow-hidden shadow-[0_20px_60px_-20px_color-mix(in_srgb,var(--color-primary-500)_25%,transparent)]"
    >
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-dark-800">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
        <span className="ml-2 font-mono text-xs text-dark-500">{title}</span>
      </div>
      <pre className="font-mono text-[12.5px] leading-6 text-dark-300 px-4 pt-3 pb-4 min-h-[17rem] whitespace-pre-wrap">
        {LINES.slice(0, line).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <div key={i}>
            {"cmd" in l ? (
              <>
                <Prompt kind={l.prompt} />
                <span className="text-white">{l.cmd}</span>
              </>
            ) : (
              l.out
            )}
          </div>
        ))}
        {cur && "cmd" in cur && (
          <div>
            <Prompt kind={cur.prompt} />
            <span className="text-white">{cur.cmd.slice(0, chars)}</span>
            <Cursor />
          </div>
        )}
        {done && (
          <div>
            <Prompt kind="remote" />
            <Cursor />
          </div>
        )}
      </pre>
    </div>
  );
}
