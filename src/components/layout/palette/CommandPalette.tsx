import {
  ArrowRightIcon,
  DesktopIcon,
  FileTextIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import RunOnHostsDialog from "@/components/snippets/RunOnHostsDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useShortcut } from "@/hooks/useShortcut";
import { findAllLeaves } from "@/lib/common/treeUtils";
import {
  buildPaletteSections,
  type CreateTarget,
  type PaletteRow,
} from "@/lib/palette/sections";
import { liveShortcutIds, runShortcutAction } from "@/lib/shortcuts/actions";
import type { ShortcutContext, ShortcutId } from "@/lib/shortcuts/registry";
import {
  BUILTIN_COMMANDS,
  onOpenCommandPalette,
  openPortForwarding,
  type PaletteMode,
  type SnippetPicker,
  terminalSnippetPicker,
} from "@/lib/terminal/paletteCommand";
import { listenAppActions } from "@/lib/window/menuActions";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";
import {
  shortcutLabel,
  useShortcutStore,
} from "@/stores/shortcuts/shortcutStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useShellStore } from "@/stores/terminal/shellStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

interface CommandPaletteProps {
  onConnect: (host: Host) => void;
  onConnectLocal?: (shell: string) => void;
  /** Goes to an app path (Layout asks about unsaved editor changes first). */
  onNavigate: (path: string) => void;
}

const CREATE_PATHS: Record<CreateTarget, string> = {
  host: "/hosts?new=host",
  group: "/hosts?new=group",
  snippet: "/snippets?new=snippet",
  key: "/keys?new=key",
};

/** What the palette needs from the app, read once when it opens. */
interface OpenState {
  mode: PaletteMode;
  live: ReadonlySet<ShortcutId>;
  activeContext: ShortcutContext | null;
  /** Set while the terminal view is open: snippet picks go into its active pane. */
  picker: SnippetPicker | null;
  /** The active pane, when it is a connected SSH host (it has port forwarding). */
  portForwardingPaneId: string | null;
}

function sshPaneId(): string | null {
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  const pane = tab?.activePaneId
    ? findAllLeaves(tab.root).find((l) => l.id === tab.activePaneId)
    : undefined;
  return pane &&
    pane.connectionType !== "local" &&
    pane.hostId &&
    pane.connectionStatus === "connected"
    ? pane.id
    : null;
}

const isMac = () => navigator.platform.includes("Mac");

/** user@host:port typed into the palette, as a one-off host. */
function directHost(query: string): Host | null {
  const match = query.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
  if (!match) return null;
  const [, username, address, port] = match;
  const now = new Date().toISOString();
  return {
    id: `direct_${Date.now()}`,
    name: address,
    address,
    port: Number.parseInt(port || "22", 10),
    username: username || "root",
    tags: [],
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function hint(row: PaletteRow | undefined, inTerminal: boolean): string {
  const mod = isMac() ? "Cmd" : "Ctrl";
  switch (row?.kind) {
    case "direct":
    case "host":
      return "Enter to connect";
    case "shell":
      return "Enter to open";
    case "snippet":
      return inTerminal
        ? `Enter to insert · ${mod}+Enter to run · ${mod}+Shift+Enter to run in all tabs`
        : "Enter to run on hosts";
    case undefined:
      return "Esc to close";
    default:
      return "Enter to run";
  }
}

/** One palette for hosts, local shells, snippets and actions (Ctrl+Shift+K / ⌘K). */
export default function CommandPalette({
  onConnect,
  onConnectLocal,
  onNavigate,
}: CommandPaletteProps) {
  const { hosts } = useHostStore();
  const shells = useShellStore((s) => s.shells);
  const snippets = useSnippetStore((s) => s.snippets);
  const [state, setState] = useState<OpenState | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [runTarget, setRunTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ignore further picks while one is still running (e.g. a double Ctrl+Enter).
  const picking = useRef(false);

  const open = useCallback((mode: PaletteMode) => {
    const { activeContext } = useShortcutStore.getState();
    setState({
      mode,
      live: liveShortcutIds(),
      activeContext,
      picker: activeContext === "terminal" ? terminalSnippetPicker() : null,
      portForwardingPaneId: activeContext === "terminal" ? sshPaneId() : null,
    });
    setQuery("");
    setSelectedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  const close = () => {
    setState(null);
    setQuery("");
  };

  // Opens from any view, even while typing (the terminal holds the key back from the shell),
  // but leaves keys the code editor already used, like Ctrl+Shift+K "delete line".
  // On macOS the menu bar owns it and opens the panel through an app action.
  useShortcut("app.quickConnect", () => open("all"), { yieldToHandled: true });
  useEffect(
    () =>
      listenAppActions((id) => {
        if (id === "quick-connect") open("all");
      }),
    [open],
  );
  useEffect(() => onOpenCommandPalette(open), [open]);

  const sections = state
    ? buildPaletteSections({
        query,
        mode: state.mode,
        hosts,
        shells,
        snippets,
        builtins: state.picker ? BUILTIN_COMMANDS : null,
        live: state.live,
        activeContext: state.activeContext,
        portForwardingPaneId: state.portForwardingPaneId,
      })
    : [];
  const rows = sections.flatMap((s) => s.rows);

  const pick = async (row: PaletteRow, run = false, all = false) => {
    if (picking.current || !state) return;
    switch (row.kind) {
      case "direct": {
        const host = directHost(row.query);
        if (host) {
          onConnect(host);
          close();
        }
        return;
      }
      case "host":
        onConnect(row.host);
        return close();
      case "shell":
        onConnectLocal?.(row.shell.path);
        return close();
      case "action":
        close();
        // After the dialog has closed and given focus back, so the action keeps its own focus.
        setTimeout(() => runShortcutAction(row.id), 0);
        return;
      case "page":
        close();
        return onNavigate(row.path);
      case "create":
        close();
        return onNavigate(CREATE_PATHS[row.target]);
      case "portForwarding":
        close();
        return openPortForwarding(row.paneId);
      case "snippet": {
        if (!state.picker) {
          if (row.item.snippetId)
            setRunTarget({ id: row.item.snippetId, name: row.label });
          return close();
        }
        picking.current = true;
        try {
          if (await state.picker(row.item, run, all)) close();
        } finally {
          picking.current = false;
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Every Enter here is the palette's; the dialog's own Enter would click a row.
    if (e.key === "Enter") e.stopPropagation();
    // Enter that confirms an IME candidate is not a pick.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && rows[selectedIndex]) {
      e.preventDefault();
      const run = isMac() ? e.metaKey : e.ctrlKey;
      void pick(rows[selectedIndex], run, run && e.shiftKey);
    }
  };

  let flat = 0;
  return (
    <>
      {state && (
        <Modal
          open
          onClose={close}
          ariaLabel="Command palette"
          maxWidth="max-w-lg"
        >
          <div className="p-0">
            <div className="flex items-center gap-3 p-4 border-b border-dark-700">
              <MagnifyingGlassIcon
                className="w-5 h-5 text-dark-400"
                weight="bold"
              />
              <input
                ref={inputRef}
                type="text"
                placeholder={
                  state.mode === "snippets"
                    ? "Search snippets"
                    : "Search hosts, actions, snippets or type user@host:port"
                }
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                className="flex-1 bg-transparent text-white placeholder-dark-400 focus:outline-none"
              />
              <Badge>Esc</Badge>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {sections.map((section) => (
                <div key={section.title}>
                  <div className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider uppercase text-dark-500">
                    {section.title}
                  </div>
                  {section.rows.map((row) => {
                    const index = flat++;
                    return (
                      <PaletteRowButton
                        key={rowKey(row)}
                        row={row}
                        selected={index === selectedIndex}
                        onPick={() => void pick(row)}
                      />
                    );
                  })}
                </div>
              ))}
              {rows.length === 0 && (
                <div className="p-4 text-center text-dark-400">No matches</div>
              )}
            </div>

            <div className="p-3 border-t border-dark-700 text-dark-500 text-xs">
              {hint(rows[selectedIndex], !!state.picker)}
            </div>
          </div>
        </Modal>
      )}
      {runTarget && (
        <RunOnHostsDialog
          snippet={runTarget}
          onClose={() => setRunTarget(null)}
        />
      )}
    </>
  );
}

function rowKey(row: PaletteRow): string {
  switch (row.kind) {
    case "direct":
      return "direct";
    case "host":
      return `host:${row.host.id}`;
    case "shell":
      return `shell:${row.shell.path}`;
    case "snippet":
      return `snippet:${row.item.snippetId ?? row.item.command}`;
    case "action":
      return `action:${row.id}`;
    case "page":
      return `page:${row.path}`;
    case "create":
      return `create:${row.target}`;
    case "portForwarding":
      return `pf:${row.paneId}`;
  }
}

function PaletteRowButton({
  row,
  selected,
  onPick,
}: {
  row: PaletteRow;
  selected: boolean;
  onPick: () => void;
}) {
  const [Icon, title, detail, color] = (() => {
    switch (row.kind) {
      case "direct":
        return [LightningIcon, `Connect to ${row.query}`, "", "#2563eb"];
      case "host":
        return [
          TerminalIcon,
          row.host.name,
          `${row.host.username ?? ""}${row.host.username ? "@" : ""}${row.host.address}:${row.host.port ?? 22}`,
          row.host.color || "#64748b",
        ];
      case "shell":
        return [DesktopIcon, row.shell.name, row.shell.path, "#16a34a"];
      case "snippet":
        return [FileTextIcon, row.label, row.detail ?? "", "#7c3aed"];
      case "action":
        return [
          LightningIcon,
          row.label,
          shortcutLabel(row.id) ?? "",
          "#475569",
        ];
      case "page":
        return [ArrowRightIcon, row.label, "", "#475569"];
      case "create":
        return [PlusIcon, row.label, "", "#475569"];
      case "portForwarding":
        return [ArrowRightIcon, row.label, "", "#475569"];
    }
  })();
  return (
    <Button
      variant="ghost"
      onClick={onPick}
      className={`w-full h-auto px-3 py-2 justify-start ${selected ? "bg-dark-800" : ""}`}
      ref={(el) => {
        if (selected) el?.scrollIntoView?.({ block: "nearest" });
      }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: color }}
      >
        <Icon className="w-4 h-4 text-white" weight="bold" />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-white text-sm truncate">{title}</div>
        {detail && row.kind !== "action" && (
          <div className="text-dark-400 text-xs truncate">{detail}</div>
        )}
      </div>
      {row.kind === "action" && detail && <Badge>{detail}</Badge>}
    </Button>
  );
}
