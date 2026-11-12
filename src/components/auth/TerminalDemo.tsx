import { type ReactNode, useEffect, useState } from "react";

type Line = { cmd: string } | { out: ReactNode };

const Ok = () => <span className="text-green-400">✓</span>;

const LINES: Line[] = [
  { cmd: "shetu login" },
  {
    out: (
      <>
        <Ok /> vault unlocked
      </>
    ),
  },
  { cmd: "shetu sync" },
  { out: <span className="text-dark-500">↻ pulling 12 hosts, 4 keys…</span> },
  {
    out: (
      <>
        <Ok /> synced{" "}
        <span className="text-dark-500">· end-to-end encrypted</span>
      </>
    ),
  },
  { cmd: "ssh deploy@prod-eu-1" },
  { out: <span className="text-dark-500">Welcome to Ubuntu 24.04 LTS</span> },
];

const Cursor = () => (
  <span className="inline-block w-2 h-4 align-[-2px] bg-primary-400 motion-safe:animate-caret-blink" />
);

const Prompt = ({ text }: { text: string }) => (
  <>
    <span className="text-primary-400">❯</span>{" "}
    <span className="text-white">{text}</span>
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
    const delay = !cur ? 4000 : typing ? 55 : "cmd" in cur ? 350 : 450;
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

  return (
    <div
      aria-hidden="true"
      className="rounded-xl border border-dark-700 bg-dark-950/85 overflow-hidden shadow-[0_20px_60px_-20px_color-mix(in_srgb,var(--color-primary-500)_25%,transparent)]"
    >
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-dark-800">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
        <span className="ml-2 font-mono text-xs text-dark-500">~ — zsh</span>
      </div>
      <pre className="font-mono text-[13px] leading-7 text-dark-300 px-4 pt-3.5 pb-4 min-h-60 whitespace-pre-wrap">
        {LINES.slice(0, line).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <div key={i}>{"cmd" in l ? <Prompt text={l.cmd} /> : l.out}</div>
        ))}
        {cur && "cmd" in cur && (
          <div>
            <Prompt text={cur.cmd.slice(0, chars)} />
            <Cursor />
          </div>
        )}
        {cur && "out" in cur && <Cursor />}
        {done && (
          <div>
            <span className="text-primary-400">deploy@prod-eu-1</span>:~${" "}
            <Cursor />
          </div>
        )}
      </pre>
    </div>
  );
}
