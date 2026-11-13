import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import { shortcutLabel } from "@/stores/shortcuts/shortcutStore";

/** The slice of an xterm Terminal the menu acts on. */
export interface TerminalMenuTarget {
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  selectAll(): void;
  clear(): void;
  focus(): void;
}

type ClipboardTarget = Pick<
  TerminalMenuTarget,
  "hasSelection" | "getSelection" | "paste" | "focus"
>;

// The Tauri clipboard plugin, not navigator.clipboard: webview clipboard reads
// are blocked or prompt on some platforms.
export function copySelection(term: ClipboardTarget): void {
  if (!term.hasSelection()) return;
  void writeText(term.getSelection()).then(
    () => term.focus(),
    () => toast.error("Couldn't copy to the clipboard"),
  );
}

export function pasteClipboard(term: ClipboardTarget): void {
  void readText().then(
    (text) => {
      if (text) term.paste(text);
      term.focus();
    },
    () => toast.error("Couldn't read the clipboard"),
  );
}

export function terminalContextMenuItems(
  term: TerminalMenuTarget,
  split: (direction: "horizontal" | "vertical") => void,
  openSnippets: () => void,
): ContextMenuItem[] {
  const then = (action: () => void) => () => {
    action();
    term.focus();
  };
  return [
    {
      label: "Copy",
      // Plain Ctrl+C belongs to the shell; macOS copies through the Edit menu.
      shortcut: shortcutLabel("terminal.copy"),
      disabled: !term.hasSelection(),
      onClick: () => copySelection(term),
    },
    {
      label: "Paste",
      shortcut: shortcutLabel("terminal.paste"),
      onClick: () => pasteClipboard(term),
    },
    { label: "Select All", onClick: then(() => term.selectAll()) },
    { type: "separator" },
    {
      label: "Snippets…",
      shortcut: shortcutLabel("terminal.palette"),
      onClick: openSnippets,
    },
    { type: "separator" },
    { label: "Clear", onClick: then(() => term.clear()) },
    { type: "separator" },
    {
      label: "Split Right",
      shortcut: shortcutLabel("terminal.splitRight"),
      onClick: () => split("horizontal"),
    },
    {
      label: "Split Down",
      shortcut: shortcutLabel("terminal.splitDown"),
      onClick: () => split("vertical"),
    },
  ];
}
