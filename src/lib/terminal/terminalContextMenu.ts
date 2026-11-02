import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import type { ContextMenuItem } from "@/components/ui/ContextMenu";

/** The slice of an xterm Terminal the menu acts on. */
export interface TerminalMenuTarget {
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  selectAll(): void;
  clear(): void;
  focus(): void;
}

// The Tauri clipboard plugin, not navigator.clipboard: webview clipboard reads
// are blocked or prompt on some platforms.
export function terminalContextMenuItems(
  term: TerminalMenuTarget,
  split: (direction: "horizontal" | "vertical") => void,
): ContextMenuItem[] {
  const then = (action: () => void) => () => {
    action();
    term.focus();
  };
  return [
    {
      label: "Copy",
      disabled: !term.hasSelection(),
      onClick: () => {
        void writeText(term.getSelection()).then(
          () => term.focus(),
          () => toast.error("Couldn't copy to the clipboard"),
        );
      },
    },
    {
      label: "Paste",
      onClick: () => {
        void readText().then(
          (text) => {
            if (text) term.paste(text);
            term.focus();
          },
          () => toast.error("Couldn't read the clipboard"),
        );
      },
    },
    { label: "Select All", onClick: then(() => term.selectAll()) },
    { type: "separator" },
    { label: "Clear", onClick: then(() => term.clear()) },
    { type: "separator" },
    { label: "Split Right", onClick: () => split("horizontal") },
    { label: "Split Down", onClick: () => split("vertical") },
  ];
}
