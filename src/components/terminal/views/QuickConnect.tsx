import {
  DesktopIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  TerminalIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import type { ShellInfo } from "@/lib/terminal/shellDetection";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";
import { useShellStore } from "@/stores/terminal/shellStore";

interface QuickConnectProps {
  onConnect: (host: Host) => void;
  onConnectLocal?: (shell: string) => void;
}

export default function QuickConnect({
  onConnect,
  onConnectLocal,
}: QuickConnectProps) {
  const { hosts } = useHostStore();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const shells = useShellStore((s) => s.shells);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredHosts = hosts.filter(
    (host) =>
      host.name.toLowerCase().includes(query.toLowerCase()) ||
      host.address.toLowerCase().includes(query.toLowerCase()),
  );

  const filteredShells = shells.filter(
    (shell) =>
      !query ||
      shell.name.toLowerCase().includes(query.toLowerCase()) ||
      shell.path.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modifier = navigator.platform.includes("Mac")
        ? e.metaKey
        : e.ctrlKey;
      // Ctrl/Cmd+K opens the panel from any view.
      if (modifier && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        // Capture phase + stopPropagation: the terminal must not also receive it.
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(true);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
      // Escape to close
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
        setQuery("");
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const noExactHost = !hosts.some(
    (h) =>
      h.name.toLowerCase() === query.toLowerCase() ||
      h.address.toLowerCase() === query.toLowerCase(),
  );

  type SelectableItem =
    | { type: "direct"; query: string }
    | { type: "shell"; shell: ShellInfo }
    | { type: "host"; host: Host };

  const selectableItems: SelectableItem[] = [];
  if (query && noExactHost) {
    selectableItems.push({ type: "direct", query });
  }
  for (const s of filteredShells) {
    selectableItems.push({ type: "shell", shell: s });
  }
  for (const h of filteredHosts) {
    selectableItems.push({ type: "host", host: h });
  }

  const close = () => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
  };

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
      if (item.type === "direct") {
        handleDirectConnect();
      } else if (item.type === "shell") {
        if (onConnectLocal) onConnectLocal(item.shell.path);
        close();
      } else if (item.type === "host") {
        onConnect(item.host);
        close();
      }
    }
  };

  // Handle direct connection with user@host:port format
  const handleDirectConnect = () => {
    // Parse user@host:port format
    const match = query.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    if (match) {
      const [, username, address, port] = match;
      const host = {
        id: `direct_${Date.now()}`,
        name: address,
        address,
        port: Number.parseInt(port || "22", 10),
        username: username || "root",
        tags: [],
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      onConnect(host);
      setIsOpen(false);
      setQuery("");
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={() => {
        setIsOpen(false);
        setQuery("");
      }}
      maxWidth="max-w-lg"
    >
      <div className="p-0">
        {/* Input */}
        <div className="flex items-center gap-3 p-4 border-b border-dark-700">
          <MagnifyingGlassIcon
            className="w-5 h-5 text-dark-400"
            weight="bold"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search hosts or type user@host:port"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-white placeholder-dark-400 focus:outline-none"
          />
          <Badge>Esc</Badge>
        </div>

        {/* Results */}
        <div ref={dropdownRef} className="max-h-80 overflow-y-auto">
          {query &&
            !filteredHosts.some(
              (h) =>
                h.name.toLowerCase() === query.toLowerCase() ||
                h.address.toLowerCase() === query.toLowerCase(),
            ) && (
              <Button
                variant="ghost"
                onClick={handleDirectConnect}
                className="w-full h-auto px-3 py-2 justify-start"
              >
                <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                  <LightningIcon className="w-4 h-4 text-white" weight="bold" />
                </div>
                <div>
                  <div className="text-white text-sm">Connect to {query}</div>
                  <div className="text-dark-400 text-xs">Direct connection</div>
                </div>
              </Button>
            )}

          {/* Local shells */}
          {filteredShells.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider uppercase text-dark-500">
                Local Shell
              </div>
              {filteredShells.map((shell, shellIdx) => {
                const flatIdx = (query && noExactHost ? 1 : 0) + shellIdx;
                return (
                  <Button
                    key={shell.path}
                    variant="ghost"
                    onClick={() => {
                      if (onConnectLocal) onConnectLocal(shell.path);
                      close();
                    }}
                    className={`w-full h-auto px-3 py-2 justify-start ${
                      flatIdx === selectedIndex ? "bg-dark-800" : ""
                    }`}
                  >
                    <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
                      <DesktopIcon
                        className="w-4 h-4 text-white"
                        weight="bold"
                      />
                    </div>
                    <div>
                      <div className="text-white text-sm">{shell.name}</div>
                      <div className="text-dark-400 text-xs">{shell.path}</div>
                    </div>
                  </Button>
                );
              })}
            </div>
          )}

          {/* Remote hosts */}
          {filteredHosts.length > 0 && (
            <div>
              {!query && shells.length > 0 && (
                <div className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider uppercase text-dark-500">
                  Remote Hosts
                </div>
              )}
              {filteredHosts.map((host, hostIdx) => {
                const flatIdx =
                  (query && noExactHost ? 1 : 0) +
                  filteredShells.length +
                  hostIdx;
                return (
                  <Button
                    key={host.id}
                    variant="ghost"
                    onClick={() => {
                      onConnect(host);
                      close();
                    }}
                    className={`w-full h-auto px-3 py-2 justify-start ${
                      flatIdx === selectedIndex ? "bg-dark-800" : ""
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: host.color || "#64748b" }}
                    >
                      <TerminalIcon
                        className="w-4 h-4 text-white"
                        weight="bold"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm">{host.name}</div>
                      <div className="text-dark-400 text-xs">
                        {host.username}@{host.address}:{host.port}
                      </div>
                    </div>
                    {host.tags && host.tags.length > 0 && (
                      <div className="flex gap-1">
                        {host.tags.slice(0, 2).map((tag: string) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 bg-dark-700 text-dark-300 text-xs rounded"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </Button>
                );
              })}
            </div>
          )}

          {filteredHosts.length === 0 &&
            filteredShells.length === 0 &&
            !query && (
              <div className="p-4 text-center text-dark-400">
                <p>No hosts or shells available</p>
                <p className="text-sm mt-1">
                  Add a host first or type a connection string
                </p>
              </div>
            )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-dark-700 text-dark-500 text-xs flex justify-between">
          <span>↑↓ Navigate • ↵ Connect • Esc Close</span>
          <span>{filteredHosts.length} hosts</span>
        </div>
      </div>
    </Modal>
  );
}
