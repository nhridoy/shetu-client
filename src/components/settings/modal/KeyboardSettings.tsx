import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { defaultShortcuts } from "@/hooks/useKeyboardShortcuts";

interface KeyboardSettingsProps {
  onClose: () => void;
}

export default function KeyboardSettings({ onClose }: KeyboardSettingsProps) {
  const [shortcuts, setShortcuts] = useState(defaultShortcuts);
  const [editingId, setEditingId] = useState<string | null>(null);

  const shortcutsByCategory = shortcuts.reduce<
    Record<string, typeof shortcuts>
  >((acc, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {});

  const handleReset = () => {
    setShortcuts(defaultShortcuts);
  };

  const getKeyDisplay = (keys: string) => {
    return keys
      .replace("Ctrl", navigator.platform.includes("Mac") ? "⌘" : "Ctrl")
      .replace("Alt", navigator.platform.includes("Mac") ? "⌥" : "Alt")
      .replace("Shift", navigator.platform.includes("Mac") ? "⇧" : "Shift")
      .replace("+", " ");
  };

  return (
    <Modal onClose={onClose}>
      <div className="bg-dark-900 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-dark-700 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-white">
            Keyboard Shortcuts
          </h3>
          <Button type="button" onClick={onClose} variant="ghost" size="icon">
            <XIcon className="w-5 h-5" weight="bold" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {Object.entries(shortcutsByCategory).map(
            ([category, categoryShortcuts]) => (
              <div key={category} className="mb-6">
                <h4 className="text-dark-400 text-sm font-medium mb-3 uppercase tracking-wider">
                  {category}
                </h4>
                <div className="space-y-2">
                  {categoryShortcuts.map((shortcut) => (
                    <div
                      key={shortcut.id}
                      className="flex items-center justify-between p-3 bg-dark-800 rounded-lg hover:bg-dark-700"
                    >
                      <div>
                        <div className="text-white text-sm">
                          {shortcut.description}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {editingId === shortcut.id ? (
                          <input
                            type="text"
                            aria-label="Shortcut keys"
                            value={shortcut.keys}
                            onChange={(e) => {
                              setShortcuts(
                                shortcuts.map((s) =>
                                  s.id === shortcut.id
                                    ? { ...s, keys: e.target.value }
                                    : s,
                                ),
                              );
                            }}
                            onBlur={() => setEditingId(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setEditingId(null);
                              }
                            }}
                            className="bg-dark-700 text-white px-2 py-1 rounded text-sm w-32"
                          />
                        ) : (
                          <Button
                            type="button"
                            onClick={() => setEditingId(shortcut.id)}
                            variant="secondary"
                            size="sm"
                            className="font-mono"
                          >
                            {getKeyDisplay(shortcut.keys)}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-dark-700 flex justify-between">
          <Button type="button" onClick={handleReset} variant="ghost">
            Reset to defaults
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
