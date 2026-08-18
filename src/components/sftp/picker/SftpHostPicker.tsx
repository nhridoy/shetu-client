import {
  DesktopTowerIcon,
  LightningIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";

interface SftpHostPickerProps {
  onConnect: (host: Host) => void;
  onClose: () => void;
}

export default function SftpHostPicker({
  onConnect,
  onClose,
}: SftpHostPickerProps) {
  const { hosts } = useHostStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.toLowerCase();
  const filteredHosts = hosts.filter(
    (host) =>
      host.name.toLowerCase().includes(q) ||
      host.address.toLowerCase().includes(q),
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filteredHosts.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      if (filteredHosts[selectedIndex]) {
        onConnect(filteredHosts[selectedIndex]);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const noExactHost = !hosts.some(
    (h) => h.name.toLowerCase() === q || h.address.toLowerCase() === q,
  );

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
        authType: "password",
        tags: [],
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Host);
      onClose();
    }
  };

  return (
    <div className="flex flex-col h-full bg-dark-900">
      {/* Search */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-700">
        <MagnifyingGlassIcon className="w-5 h-5 text-dark-400" weight="bold" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search hosts or type user@host:port"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm text-white bg-transparent placeholder-dark-400 focus:outline-none"
        />
        {query && (
          <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
            Clear
          </Button>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {/* Direct connect option */}
        {query && noExactHost && (
          <Button
            variant="ghost"
            onClick={handleDirectConnect}
            className="flex items-center w-full gap-3 px-4 py-3 text-left justify-start hover:bg-dark-800"
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

        {/* Hosts */}
        <div className="pb-2">
          {filteredHosts.length === 0 ? (
            <div className="px-4 py-3 text-sm text-dark-500">
              {query
                ? "No hosts match your search"
                : "No hosts available — add a host or type a connection string"}
            </div>
          ) : (
            filteredHosts.map((host, index) => (
              <Button
                variant="ghost"
                key={host.id}
                onClick={() => {
                  onConnect(host);
                  onClose();
                }}
                className={`w-full px-4 py-3 flex items-center gap-3 text-left justify-start ${
                  index === selectedIndex ? "bg-dark-800" : "hover:bg-dark-800"
                }`}
              >
                <div
                  className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg"
                  style={{ backgroundColor: host.color || "#64748b" }}
                >
                  <DesktopTowerIcon
                    className="w-4 h-4 text-white"
                    weight="bold"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white">{host.name}</div>
                  <div className="text-xs text-dark-400">
                    {host.username ? `${host.username}@` : ""}
                    {host.address}:{host.port}
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
            ))
          )}
        </div>

        {/* No results */}
        {query && filteredHosts.length === 0 && noExactHost && (
          <div className="px-4 py-3 text-sm text-dark-500">
            No matches for "{query}"
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between px-4 py-2 text-xs border-t border-dark-700 text-dark-500">
        <span>↑↓ Navigate • ↵ Connect • Esc Cancel</span>
        <span>{filteredHosts.length} hosts</span>
      </div>
    </div>
  );
}
