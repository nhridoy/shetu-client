import { useCallback, useEffect } from "react";
import { hasMacMenu, isMenuOwnedShortcut } from "@/lib/window/menuActions";

export interface KeyboardShortcut {
  id: string;
  keys: string;
  description: string;
  category: string;
  action: () => void;
}

interface UseKeyboardShortcutsProps {
  onNewTab?: () => void;
  onCloseTab?: () => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onFocusMode?: () => void;
  onCommandPalette?: () => void;
  onSaveWorkspace?: () => void;
  onToggleSidebar?: () => void;
}

export function useKeyboardShortcuts({
  onNewTab,
  onCloseTab,
  onNextTab,
  onPrevTab,
  onSplitHorizontal,
  onSplitVertical,
  onFocusMode,
  onCommandPalette,
  onSaveWorkspace,
  onToggleSidebar,
}: UseKeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // The macOS menu bar handles these keys itself.
      if (isMenuOwnedShortcut(e, hasMacMenu())) return;
      const isMac = navigator.platform.includes("Mac");
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      // New tab: Ctrl+T / Cmd+T
      if (modifier && e.key === "t" && onNewTab) {
        e.preventDefault();
        onNewTab();
      }

      // Close pane, then tab: Ctrl+W / Cmd+W
      if (modifier && e.key === "w" && onCloseTab) {
        e.preventDefault();
        onCloseTab();
      }

      // Next tab: Ctrl+Tab / Cmd+Tab
      if (modifier && e.key === "Tab" && onNextTab) {
        e.preventDefault();
        if (e.shiftKey) {
          onPrevTab?.();
        } else {
          onNextTab();
        }
      }

      // Previous tab: Ctrl+Shift+Tab / Cmd+Shift+Tab
      if (modifier && e.shiftKey && e.key === "Tab" && onPrevTab) {
        e.preventDefault();
        onPrevTab();
      }

      // Split horizontal: Ctrl+\ / Cmd+\
      if (modifier && e.key === "\\" && onSplitHorizontal) {
        e.preventDefault();
        onSplitHorizontal();
      }

      // Split vertical: Ctrl+Shift+\ / Cmd+Shift+\
      if (modifier && e.shiftKey && e.key === "\\" && onSplitVertical) {
        e.preventDefault();
        onSplitVertical();
      }

      // Focus mode: F11
      if (e.key === "F11" && onFocusMode) {
        e.preventDefault();
        onFocusMode();
      }

      // Command palette: Ctrl+Shift+P / Cmd+Shift+P
      if (modifier && e.shiftKey && e.key === "P" && onCommandPalette) {
        e.preventDefault();
        onCommandPalette();
      }

      // Save workspace: Ctrl+S / Cmd+S
      if (modifier && e.key === "s" && onSaveWorkspace) {
        e.preventDefault();
        onSaveWorkspace();
      }

      // Toggle sidebar: Ctrl+B / Cmd+B
      if (modifier && e.key === "b" && onToggleSidebar) {
        e.preventDefault();
        onToggleSidebar();
      }
    },
    [
      onNewTab,
      onCloseTab,
      onNextTab,
      onPrevTab,
      onSplitHorizontal,
      onSplitVertical,
      onFocusMode,
      onCommandPalette,
      onSaveWorkspace,
      onToggleSidebar,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

// Default shortcuts configuration
export const defaultShortcuts: Omit<KeyboardShortcut, "action">[] = [
  { id: "new-tab", keys: "Ctrl+T", description: "New tab", category: "Tabs" },
  {
    id: "close-tab",
    keys: "Ctrl+W",
    description: "Close pane (closes the tab after its last pane)",
    category: "Tabs",
  },
  {
    id: "next-tab",
    keys: "Ctrl+Tab",
    description: "Next tab",
    category: "Tabs",
  },
  {
    id: "prev-tab",
    keys: "Ctrl+Shift+Tab",
    description: "Previous tab",
    category: "Tabs",
  },
  {
    id: "split-h",
    keys: "Ctrl+\\",
    description: "Split horizontal",
    category: "Split",
  },
  {
    id: "split-v",
    keys: "Ctrl+Shift+\\",
    description: "Split vertical",
    category: "Split",
  },
  {
    id: "focus-mode",
    keys: "F11",
    description: "Toggle focus mode",
    category: "View",
  },
  {
    id: "quick-connect",
    keys: "Ctrl+K",
    description: "Quick connect",
    category: "Connection",
  },
  {
    id: "command-palette",
    keys: "Ctrl+Shift+P",
    description: "Command palette",
    category: "General",
  },
  {
    id: "save-workspace",
    keys: "Ctrl+S",
    description: "Save workspace",
    category: "Workspace",
  },
  {
    id: "toggle-sidebar",
    keys: "Ctrl+B",
    description: "Toggle sidebar",
    category: "View",
  },
];
