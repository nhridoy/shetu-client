import { TerminalIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { PaletteItem } from "@/lib/terminal/paletteCommand";
import { useSnippetStore } from "@/stores/snippets/snippetStore";

interface CommandAutocompleteProps {
  isVisible: boolean;
  /** `run` is true for Ctrl+Enter (Cmd+Enter on macOS); Enter and click insert. */
  /** May return a promise; picks are ignored until it settles. */
  onSelect: (item: PaletteItem, run: boolean) => unknown;
  onClose: () => void;
}

const isMac = () => navigator.platform.includes("Mac");

export default function CommandAutocomplete({
  isVisible,
  onSelect,
  onClose,
}: CommandAutocompleteProps) {
  const { snippets } = useSnippetStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ignore further picks while one is still running (e.g. a double Ctrl+Enter).
  const picking = useRef(false);

  const q = query.toLowerCase();
  // Snippet commands are encrypted in list state, so search the plaintext fields.
  const filteredCommands = snippets.filter((snippet) =>
    [snippet.name, snippet.description ?? "", ...snippet.tags].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );

  // Common Linux commands
  const commonCommands = [
    {
      name: "ls -la",
      command: "ls -la",
      description: "List files with details",
    },
    { name: "cd", command: "cd ", description: "Change directory" },
    { name: "pwd", command: "pwd", description: "Print working directory" },
    { name: "mkdir", command: "mkdir ", description: "Create directory" },
    {
      name: "rm -rf",
      command: "rm -rf ",
      description: "Remove files (careful!)",
    },
    { name: "cp -r", command: "cp -r ", description: "Copy recursively" },
    { name: "mv", command: "mv ", description: "Move/rename" },
    { name: "chmod", command: "chmod ", description: "Change permissions" },
    { name: "chown", command: "chown ", description: "Change ownership" },
    { name: "cat", command: "cat ", description: "View file contents" },
    {
      name: "tail -f",
      command: "tail -f ",
      description: "Follow file changes",
    },
    { name: "grep", command: "grep ", description: "Search text" },
    { name: "find", command: "find ", description: "Find files" },
    { name: "ps aux", command: "ps aux", description: "List processes" },
    { name: "top", command: "top", description: "Process monitor" },
    { name: "htop", command: "htop", description: "Better process monitor" },
    { name: "df -h", command: "df -h", description: "Disk usage" },
    { name: "du -sh", command: "du -sh ", description: "Directory size" },
    { name: "free -m", command: "free -m", description: "Memory usage" },
    { name: "uptime", command: "uptime", description: "System uptime" },
    { name: "whoami", command: "whoami", description: "Current user" },
    { name: "hostname", command: "hostname", description: "System hostname" },
    { name: "uname -a", command: "uname -a", description: "System info" },
    { name: "curl", command: "curl ", description: "HTTP requests" },
    { name: "wget", command: "wget ", description: "Download files" },
    { name: "ssh", command: "ssh ", description: "SSH connect" },
    { name: "scp", command: "scp ", description: "Secure copy" },
    { name: "rsync", command: "rsync ", description: "Sync files" },
    { name: "git status", command: "git status", description: "Git status" },
    { name: "git pull", command: "git pull", description: "Git pull" },
    { name: "git push", command: "git push", description: "Git push" },
    {
      name: "docker ps",
      command: "docker ps",
      description: "Docker containers",
    },
    {
      name: "docker compose",
      command: "docker compose ",
      description: "Docker Compose",
    },
    {
      name: "systemctl status",
      command: "systemctl status ",
      description: "Service status",
    },
    {
      name: "systemctl restart",
      command: "systemctl restart ",
      description: "Restart service",
    },
    { name: "journalctl", command: "journalctl -u ", description: "View logs" },
  ];

  const allCommands = [
    ...filteredCommands.map((s) => ({
      key: `snippet:${s.id}`,
      label: s.name,
      item: { snippetId: s.id, command: "" } as PaletteItem,
      description: s.description,
      isSnippet: true,
    })),
    ...commonCommands
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.command.toLowerCase().includes(q),
      )
      .map((c) => ({
        key: `builtin:${c.command}`,
        label: c.command,
        item: { command: c.command } as PaletteItem,
        description: c.description,
        isSnippet: false,
      })),
  ];

  // Only these rows are rendered, so keyboard selection stays within them.
  const visible = allCommands.slice(0, 10);

  const pick = (item: PaletteItem, run: boolean) => {
    if (picking.current) return;
    const result = onSelect(item, run);
    if (result instanceof Promise) {
      picking.current = true;
      void result.finally(() => {
        picking.current = false;
      });
    }
  };

  useEffect(() => {
    if (isVisible) {
      setQuery("");
      setSelectedIndex(0);
      const id = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(id);
    }
  }, [isVisible]);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter that confirms an IME candidate belongs to the search box.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && visible[selectedIndex]) {
      e.preventDefault();
      const run = isMac() ? e.metaKey : e.ctrlKey;
      // The caller closes the palette on success; it stays open on failure.
      pick(visible[selectedIndex].item, run);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  if (!isVisible) return null;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-40"
        onClick={onClose}
      />

      {/* Autocomplete panel */}
      <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl">
        <div className="bg-dark-900 rounded-xl shadow-2xl border border-dark-700 overflow-hidden">
          {/* Input */}
          <div className="flex items-center gap-3 p-3 border-b border-dark-700">
            <TerminalIcon className="w-5 h-5 text-primary-500" />
            <input
              ref={inputRef}
              type="text"
              aria-label="Search commands"
              placeholder="Search commands..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-white placeholder-dark-400 focus:outline-none"
            />
            <kbd className="px-2 py-1 bg-dark-700 rounded text-dark-300 text-xs">
              Tab
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-60 overflow-y-auto">
            {allCommands.length === 0 ? (
              <div className="p-4 text-center text-dark-400">
                No commands found
              </div>
            ) : (
              visible.map((cmd, index) => (
                <Button
                  variant="ghost"
                  key={cmd.key}
                  ref={
                    index === selectedIndex
                      ? (el: HTMLButtonElement | null) =>
                          el?.scrollIntoView?.({ block: "nearest" })
                      : undefined
                  }
                  onClick={() => pick(cmd.item, false)}
                  className={`w-full h-auto px-4 py-2 justify-start ${
                    index === selectedIndex ? "bg-dark-800" : ""
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-mono">
                        {cmd.label}
                      </span>
                      {cmd.isSnippet && (
                        <Badge variant="primary">snippet</Badge>
                      )}
                    </div>
                    {cmd.description && (
                      <div className="text-dark-400 text-xs mt-0.5">
                        {cmd.description}
                      </div>
                    )}
                  </div>
                </Button>
              ))
            )}
          </div>
          <div className="px-4 py-2 border-t border-dark-700 text-xs text-dark-400">
            Enter to insert · {isMac() ? "Cmd" : "Ctrl"}+Enter to run
          </div>
        </div>
      </div>
    </>
  );
}
