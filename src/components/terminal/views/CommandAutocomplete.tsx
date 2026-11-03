import { TerminalIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useSnippetStore } from "@/stores/snippets/snippetStore";

interface CommandAutocompleteProps {
  isVisible: boolean;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export default function CommandAutocomplete({
  isVisible,
  onSelect,
  onClose,
}: CommandAutocompleteProps) {
  const { snippets } = useSnippetStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredCommands = snippets.filter(
    (snippet) =>
      snippet.name.toLowerCase().includes(query.toLowerCase()) ||
      snippet.command.toLowerCase().includes(query.toLowerCase()),
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
      name: s.name,
      command: s.command,
      description: s.description,
      isSnippet: true,
    })),
    ...commonCommands.filter(
      (c) =>
        !filteredCommands.some((s) => s.command === c.command) &&
        (c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.command.toLowerCase().includes(query.toLowerCase())),
    ),
  ];

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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, allCommands.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && allCommands[selectedIndex]) {
      onSelect(allCommands[selectedIndex].command);
      onClose();
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
              onChange={(e) => setQuery(e.target.value)}
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
              allCommands.slice(0, 10).map((cmd, index) => (
                <Button
                  variant="ghost"
                  key={cmd.command}
                  onClick={() => {
                    onSelect(cmd.command);
                    onClose();
                  }}
                  className={`w-full h-auto px-4 py-2 justify-start ${
                    index === selectedIndex ? "bg-dark-800" : ""
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-mono">
                        {cmd.command}
                      </span>
                      {"isSnippet" in cmd && cmd.isSnippet && (
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
        </div>
      </div>
    </>
  );
}
