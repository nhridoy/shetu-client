import { useShortcut } from "./useShortcut";

interface UseKeyboardShortcutsProps {
  onNewTab?: () => void;
  onCloseTab?: () => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onCommandPalette?: () => void;
}

/** The terminal view's shortcuts, on the user's bindings (Settings → Keyboard). */
export function useKeyboardShortcuts({
  onNewTab,
  onCloseTab,
  onNextTab,
  onPrevTab,
  onSplitHorizontal,
  onSplitVertical,
  onCommandPalette,
}: UseKeyboardShortcutsProps) {
  const run = (cb?: () => void) => [() => cb?.(), { enabled: !!cb }] as const;
  useShortcut("terminal.newTab", ...run(onNewTab));
  useShortcut("terminal.closePane", ...run(onCloseTab));
  useShortcut("terminal.nextTab", ...run(onNextTab));
  useShortcut("terminal.prevTab", ...run(onPrevTab));
  useShortcut("terminal.splitRight", ...run(onSplitHorizontal));
  useShortcut("terminal.splitDown", ...run(onSplitVertical));
  useShortcut("terminal.palette", ...run(onCommandPalette));
}
