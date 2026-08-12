import {
  DesktopIcon,
  FileIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import WorkspaceForm from "@/components/workspaces/forms/WorkspaceForm";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import type { ShellInfo } from "@/lib/terminal/shellDetection";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";
import { useTabGroupStore } from "@/stores/sessions/tabGroupStore";
import { useShellStore } from "@/stores/terminal/shellStore";
import type { PaneNode } from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

interface HostBrowserProps {
  onConnect: (host: Host) => void;
  onConnectLocal: (shell: string) => void;
  onRestorePreset: (preset: {
    id?: string;
    name?: string;
    layout: string;
  }) => void;
}

function previewFromLayout(layoutStr: string): {
  paneCount: number;
  hosts: string[];
} {
  try {
    const root = JSON.parse(layoutStr);
    let paneCount = 0;
    const hosts: string[] = [];
    const collect = (node: PaneNode) => {
      if (!node) return;
      if (node.type === "leaf") {
        paneCount++;
        if (node.hostName) hosts.push(node.hostName);
      } else if (node.children) {
        node.children.forEach(collect);
      }
    };
    collect(root);
    return { paneCount, hosts };
  } catch {
    return { paneCount: 0, hosts: [] };
  }
}

export default function HostBrowser({
  onConnect,
  onConnectLocal,
  onRestorePreset,
}: HostBrowserProps) {
  const { hosts } = useHostStore();
  const { currentVaultId } = useVaultStore();
  const { tabGroups, fetchTabGroups, renameTabGroup, deleteTabGroup } =
    useTabGroupStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const renameModal = useModal();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const deleteDialog = useModal();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const shells = useShellStore((s) => s.shells);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchTabGroups(currentVaultId || undefined);
  }, [currentVaultId, fetchTabGroups]);

  const q = query.toLowerCase();
  const filteredHosts = hosts.filter(
    (host) =>
      host.name.toLowerCase().includes(q) ||
      host.tags.some((tag) => tag.toLowerCase().includes(q)),
  );
  const presetMatches = tabGroups.filter((g) =>
    g.name.toLowerCase().includes(q),
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const noExactHost = !hosts.some(
    (h) => h.name.toLowerCase() === q || h.tags.some((t) => t.toLowerCase() === q),
  );

  // Build a flat list of all selectable items for keyboard navigation
  type SelectableItem =
    | { type: "direct"; query: string }
    | { type: "preset"; preset: (typeof tabGroups)[number] }
    | { type: "shell"; shell: ShellInfo }
    | { type: "host"; host: Host };

  const selectableItems: SelectableItem[] = [];
  if (query && noExactHost) {
    selectableItems.push({ type: "direct", query });
  }
  for (const g of presetMatches) {
    selectableItems.push({ type: "preset", preset: g });
  }
  if (!query) {
    for (const s of shells) {
      selectableItems.push({ type: "shell", shell: s });
    }
  }
  if (query) {
    for (const s of shells) {
      selectableItems.push({ type: "shell", shell: s });
    }
  }
  for (const h of filteredHosts) {
    selectableItems.push({ type: "host", host: h });
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        Math.min(prev + 1, selectableItems.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectableItems[selectedIndex]) {
      const item = selectableItems[selectedIndex];
      if (item.type === "direct") handleDirectConnect();
      else if (item.type === "preset") onRestorePreset(item.preset);
      else if (item.type === "shell") onConnectLocal(item.shell.path);
      else if (item.type === "host") onConnect(item.host);
    }
  };

  const handleDirectConnect = () => {
    const match = query.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    if (match) {
      const [, username, address, port] = match;
      onConnect({
        id: `direct_${Date.now()}`,
        name: address,
        address,
        port: Number.parseInt(port || "22", 10),
        username: username || "root",
        tags: [],
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const openRename = (id: string) => {
    setRenamingId(id);
    renameModal.show();
  };

  const handleRenameSubmit = (name: string) => {
    if (renamingId) renameTabGroup(renamingId, name);
    renameModal.hide();
    setRenamingId(null);
  };

  const showPresets = !query || presetMatches.length > 0;
  const showHosts = !query || filteredHosts.length > 0;

  return (
    <div className="flex flex-col h-full bg-dark-900 @container">
      {/* Search */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-700">
        <MagnifyingGlassIcon className="w-5 h-5 text-dark-400" weight="bold" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search hosts or presets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm text-white bg-transparent placeholder-dark-400 focus:outline-none"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setQuery("")}
            className="text-xs"
          >
            Clear
          </Button>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {query &&
          !filteredHosts.some(
            (h) =>
              h.name.toLowerCase() === q ||
              h.tags.some((t) => t.toLowerCase() === q),
          ) && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleDirectConnect}
              className="w-full gap-3 px-4 py-3 text-left justify-start"
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary-600">
                <LightningIcon className="w-4 h-4 text-white" weight="bold" />
              </div>
              <div>
                <div className="text-sm text-white">Connect to {query}</div>
                <div className="text-xs text-dark-400">Direct connection</div>
              </div>
            </Button>
          )}

        {/* Quick Presets section */}
        {showPresets && (
          <div className="pb-2">
            <h3 className="px-4 pt-4 pb-1 text-sm font-semibold tracking-wider uppercase text-dark-400">
              Quick Presets
            </h3>
            {presetMatches.length === 0 ? (
              <div className="px-4 py-3 text-sm text-dark-500">
                {query
                  ? "No presets match your search"
                  : "No presets yet — split panes in a tab and click the save icon"}
              </div>
            ) : (
              presetMatches.map((g) => {
                const { paneCount, hosts: gHosts } = previewFromLayout(
                  g.layout,
                );
                return (
                  // biome-ignore lint/a11y/useSemanticElements: contains nested <button> elements for rename/delete
                  <div
                    key={g.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onRestorePreset(g)}
                    onKeyDown={accessibleClickHandler(() => onRestorePreset(g))}
                    className="group relative flex items-center w-full gap-3 px-4 py-3 text-left cursor-pointer hover:bg-dark-800"
                  >
                    <div className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg bg-primary-600">
                      <FileIcon className="w-4 h-4 text-white" weight="bold" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">
                        {g.name}
                      </div>
                      <div className="text-xs text-dark-400 truncate">
                        {paneCount} pane{paneCount === 1 ? "" : "s"}
                        {gHosts.length > 0 &&
                          ` • ${gHosts.slice(0, 3).join(", ")}${gHosts.length > 3 ? ` +${gHosts.length - 3}` : ""}`}
                      </div>
                    </div>
                    <div className="absolute flex items-center gap-1 transition-opacity opacity-0 right-2 group-hover:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRename(g.id);
                        }}
                        className="rounded"
                        title="Rename preset"
                      >
                        <PencilSimpleIcon className="w-3 h-3" weight="bold" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTargetId(g.id);
                          deleteDialog.show();
                        }}
                        className="hover:text-red-500 rounded"
                        title="Delete preset"
                      >
                        <TrashIcon className="w-3 h-3" weight="bold" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Local Terminal section */}
        {!query && shells.length > 0 && (
          <div className="pb-2">
            <h3 className="px-4 pt-2 pb-1 text-sm font-semibold tracking-wider uppercase text-dark-400">
              Local Terminal
            </h3>
            <div className="grid grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-2 px-4 pt-2">
              {shells.map((shell) => (
                <Button
                  key={shell.path}
                  type="button"
                  variant="ghost"
                  onClick={() => onConnectLocal(shell.path)}
                  className="w-full px-4 py-3 gap-3 text-left justify-start border border-dark-700"
                >
                  <div className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg bg-green-600">
                    <DesktopIcon className="w-4 h-4 text-white" weight="bold" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white">{shell.name}</div>
                    <div className="text-xs text-dark-400">{shell.path}</div>
                  </div>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Hosts section */}
        {showHosts && (
          <div className="pb-2">
            <h3 className="px-4 pt-2 pb-1 text-sm font-semibold tracking-wider uppercase text-dark-400">
              Hosts
            </h3>
            {filteredHosts.length === 0 ? (
              <div className="px-4 py-3 text-sm text-dark-500">
                {query
                  ? "No hosts match your search"
                  : "No hosts available — add a host or type a connection string"}
              </div>
            ) : (
              <div className="grid grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-2 px-4 pt-2">
                {filteredHosts.map((host, index) => (
                  <Button
                    key={host.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onConnect(host)}
                    className={`w-full px-4 py-3 gap-3 text-left justify-start border border-dark-700 ${
                      index === selectedIndex ? "bg-dark-800" : ""
                    }`}
                  >
                    <div
                      className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg"
                      style={{ backgroundColor: host.color || "#64748b" }}
                    >
                      <TerminalIcon
                        className="w-4 h-4 text-white"
                        weight="bold"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white">{host.name}</div>
                      <div className="text-xs text-dark-400 capitalize">
                        SSH • {host.os || "unknown"} •{" "}
                        {formatRelativeTime(Number(host.createdAt))}
                      </div>
                    </div>
                    {host.tags && host.tags.length > 0 && (
                      <div className="flex gap-1">
                        {host.tags.slice(0, 2).map((tag: string) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* No results at all */}
        {query && !showPresets && !showHosts && noExactHost && (
          <div className="px-4 py-3 text-sm text-dark-500">
            No matches for “{query}”
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between px-4 py-2 text-xs border-t border-dark-700 text-dark-500">
        <span>↑↓ Navigate • ↵ Connect</span>
        <span>{filteredHosts.length} hosts</span>
      </div>

      {renameModal.open && (
        <WorkspaceForm
          title="Rename Preset"
          submitLabel="Rename"
          initialName={tabGroups.find((g) => g.id === renamingId)?.name || ""}
          onSubmit={handleRenameSubmit}
          onClose={() => {
            renameModal.hide();
            setRenamingId(null);
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message="Delete this preset?"
        onConfirm={() => {
          deleteDialog.hide();
          if (deleteTargetId) deleteTabGroup(deleteTargetId);
          setDeleteTargetId(null);
        }}
        onCancel={() => {
          deleteDialog.hide();
          setDeleteTargetId(null);
        }}
      />
    </div>
  );
}
