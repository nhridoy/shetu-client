import { SIDEBAR_ITEMS } from "@/components/layout/shell/sidebarItems";
import {
  SHORTCUTS,
  type ShortcutContext,
  type ShortcutId,
} from "@/lib/shortcuts/registry";
import type { PaletteItem } from "@/lib/terminal/paletteCommand";
import type { ShellInfo } from "@/lib/terminal/shellDetection";
import type { Host } from "@/stores/hosts/hostStore";

export type CreateTarget = "host" | "group" | "snippet" | "key";

export type PaletteRow =
  | { kind: "direct"; query: string }
  | { kind: "host"; host: Host }
  | { kind: "shell"; shell: ShellInfo }
  | { kind: "snippet"; item: PaletteItem; label: string; detail?: string }
  | { kind: "action"; id: ShortcutId; label: string }
  | { kind: "page"; path: string; label: string }
  | { kind: "create"; target: CreateTarget; label: string }
  | { kind: "portForwarding"; paneId: string; label: string };

export interface PaletteSection {
  title: "Hosts" | "Local shells" | "Snippets" | "Actions";
  rows: PaletteRow[];
}

const CAP = 8;

/** `user@host:port` typed into the palette: a name or IPv4 host, `[IPv6]`, or a bare IPv6 address. */
export function parseDirectTarget(
  text: string,
): { username?: string; address: string; port?: number } | null {
  const m = text
    .trim()
    .match(
      /^(?:([^@\s]+)@)?(?:\[([0-9a-fA-F:.]+)\]|([^@:\s[\]]+)|([0-9a-fA-F]*:[0-9a-fA-F]*:[0-9a-fA-F:.]*))(?::(\d+))?$/,
    );
  if (!m) return null;
  const [, username, bracketed, host, bare, port] = m;
  return {
    username,
    address: bracketed ?? host ?? bare,
    port: port ? Number.parseInt(port, 10) : undefined,
  };
}

const CREATES: { target: CreateTarget; label: string }[] = [
  { target: "host", label: "New host" },
  { target: "group", label: "New group" },
  { target: "snippet", label: "New snippet" },
  { target: "key", label: "New key" },
];

/** Everything the palette shows for `query`, in section order, empty sections left out. */
export function buildPaletteSections(input: {
  query: string;
  mode: "all" | "snippets";
  hosts: Host[];
  shells: ShellInfo[];
  /** Snippet commands are encrypted in list state, so only plaintext fields are searched. */
  snippets: {
    id: string;
    name: string;
    description?: string;
    tags: string[];
  }[];
  builtins: { name: string; command: string; description: string }[] | null;
  live: ReadonlySet<ShortcutId>;
  activeContext: ShortcutContext | null;
  portForwardingPaneId: string | null;
}): PaletteSection[] {
  const q = input.query.trim().toLowerCase();
  const has = (...fields: (string | undefined)[]) =>
    fields.some((f) => f?.toLowerCase().includes(q));
  const cap = <T>(rows: T[]) => (q ? rows : rows.slice(0, CAP));

  const snippets: PaletteRow[] = cap([
    ...input.snippets
      .filter((s) => has(s.name, s.description, ...s.tags))
      .map((s) => ({
        kind: "snippet" as const,
        item: { snippetId: s.id, command: "" },
        label: s.name,
        detail: s.description,
      })),
    // Common commands only when filtering to snippets, so they never shadow an action.
    ...(input.mode === "snippets" ? (input.builtins ?? []) : [])
      .filter((b) => has(b.name, b.command))
      .map((b) => ({
        kind: "snippet" as const,
        item: { command: b.command },
        label: b.name,
        detail: b.description,
      })),
  ]);
  if (input.mode === "snippets")
    return snippets.length ? [{ title: "Snippets", rows: snippets }] : [];

  const hosts: PaletteRow[] = cap(
    input.hosts
      .filter((h) => has(h.name, h.address))
      .map((host) => ({ kind: "host" as const, host })),
  );
  const exact = input.hosts.some(
    (h) => h.name.toLowerCase() === q || h.address.toLowerCase() === q,
  );
  // Only address-like text (user@host, an IP, a domain), so typing an action's name never
  // puts a connection first.
  if (/[@.:]/.test(q) && parseDirectTarget(q) && !exact)
    hosts.unshift({ kind: "direct", query: input.query.trim() });

  const shells: PaletteRow[] = cap(
    input.shells
      .filter((s) => has(s.name, s.path))
      .map((shell) => ({ kind: "shell" as const, shell })),
  );

  const actions: PaletteRow[] = cap(
    [
      ...SHORTCUTS.filter(
        (d) =>
          d.palette !== false &&
          input.live.has(d.id) &&
          (d.context === "app" || d.context === input.activeContext),
      ).map((d) => ({ kind: "action" as const, id: d.id, label: d.label })),
      ...SIDEBAR_ITEMS.map((p) => ({
        kind: "page" as const,
        path: p.path,
        label: `Go to ${p.label}`,
      })),
      ...CREATES.map((c) => ({ kind: "create" as const, ...c })),
      ...(input.portForwardingPaneId
        ? [
            {
              kind: "portForwarding" as const,
              paneId: input.portForwardingPaneId,
              label: "Port forwarding",
            },
          ]
        : []),
    ].filter((r) => has(r.label)),
  );

  const sections: PaletteSection[] = [
    { title: "Hosts", rows: hosts },
    { title: "Local shells", rows: shells },
    { title: "Snippets", rows: snippets },
    { title: "Actions", rows: actions },
  ];
  return sections.filter((s) => s.rows.length > 0);
}
