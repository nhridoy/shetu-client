/** Every shortcut the app defines itself. Defaults per the custom-shortcuts design. */

export type ShortcutContext = "app" | "terminal" | "files" | "editor";

export type ShortcutId =
  | "app.quickConnect"
  | "app.settings"
  | "app.searchHosts"
  | "terminal.newTab"
  | "terminal.closePane"
  | "terminal.nextTab"
  | "terminal.prevTab"
  | "terminal.splitRight"
  | "terminal.splitDown"
  | "terminal.palette"
  | "terminal.copy"
  | "terminal.paste"
  | "files.copy"
  | "files.cut"
  | "files.paste"
  | "files.newFile"
  | "files.newFolder"
  | "files.selectAll"
  | "files.rename"
  | "files.refresh"
  | "files.delete"
  | "files.up"
  | "editor.quickOpen"
  | "editor.toggleFiles"
  | "editor.save"
  | "editor.copyPath"
  | "editor.rename"
  | "editor.delete";

export interface ShortcutDef {
  id: ShortcutId;
  context: ShortcutContext;
  label: string;
  /** Default on Linux/Windows (may use "mod"). */
  other: string;
  /** Default on macOS (may use "mod"); "" = none. */
  mac: string;
  /** Fires in text boxes and the terminal. */
  whileTyping: boolean;
  /** macOS menu-bar item that owns this shortcut there. */
  menuItem?: "new-tab" | "close-tab" | "quick-connect" | "settings";
  /** Shown but not rebindable on macOS. */
  macFixed?: boolean;
  /** What macOS shows for a fixed system key, e.g. "⌘C". */
  macLabel?: string;
}

const def = (
  id: ShortcutId,
  context: ShortcutContext,
  label: string,
  other: string,
  mac: string,
  whileTyping: boolean,
  extra: Partial<ShortcutDef> = {},
): ShortcutDef => ({ id, context, label, other, mac, whileTyping, ...extra });

export const SHORTCUTS: readonly ShortcutDef[] = [
  def(
    "app.quickConnect",
    "app",
    "Quick Connect",
    "ctrl+shift+k",
    "meta+k",
    true,
    {
      menuItem: "quick-connect",
    },
  ),
  def("app.settings", "app", "Settings", "ctrl+comma", "meta+comma", true, {
    menuItem: "settings",
  }),
  def("app.searchHosts", "app", "Search hosts", "slash", "slash", false),
  def(
    "terminal.newTab",
    "terminal",
    "New tab",
    "ctrl+shift+t",
    "meta+t",
    true,
    {
      menuItem: "new-tab",
    },
  ),
  def(
    "terminal.closePane",
    "terminal",
    "Close pane",
    "ctrl+shift+w",
    "meta+w",
    true,
    {
      menuItem: "close-tab",
    },
  ),
  def("terminal.nextTab", "terminal", "Next tab", "ctrl+tab", "meta+tab", true),
  def(
    "terminal.prevTab",
    "terminal",
    "Previous tab",
    "ctrl+shift+tab",
    "shift+meta+tab",
    true,
  ),
  def(
    "terminal.splitRight",
    "terminal",
    "Split right",
    "ctrl+backslash",
    "meta+backslash",
    true,
  ),
  def(
    "terminal.splitDown",
    "terminal",
    "Split down",
    "ctrl+shift+backslash",
    "shift+meta+backslash",
    true,
  ),
  def(
    "terminal.palette",
    "terminal",
    "Snippets palette",
    "ctrl+shift+p",
    "shift+meta+p",
    true,
  ),
  def("terminal.copy", "terminal", "Copy", "ctrl+shift+c", "", true, {
    macFixed: true,
    macLabel: "⌘C",
  }),
  def("terminal.paste", "terminal", "Paste", "ctrl+shift+v", "", true, {
    macFixed: true,
    macLabel: "⌘V",
  }),
  def("files.copy", "files", "Copy", "mod+c", "mod+c", false),
  def("files.cut", "files", "Cut", "mod+x", "mod+x", false),
  def("files.paste", "files", "Paste", "mod+v", "mod+v", false),
  def("files.newFile", "files", "New file", "mod+n", "mod+n", false),
  def(
    "files.newFolder",
    "files",
    "New folder",
    "mod+shift+n",
    "mod+shift+n",
    false,
  ),
  def("files.selectAll", "files", "Select all", "mod+a", "mod+a", false),
  def("files.rename", "files", "Rename", "f2", "f2", false),
  def("files.refresh", "files", "Refresh", "f5", "f5", false),
  def("files.delete", "files", "Delete", "delete", "delete", false),
  def("files.up", "files", "Up a folder", "backspace", "backspace", false),
  def("editor.quickOpen", "editor", "Quick open", "mod+p", "mod+p", true),
  def(
    "editor.toggleFiles",
    "editor",
    "Toggle file list",
    "mod+b",
    "mod+b",
    false,
  ),
  def("editor.save", "editor", "Save", "mod+s", "mod+s", true),
  def("editor.copyPath", "editor", "Copy path", "mod+c", "mod+c", false),
  def("editor.rename", "editor", "Rename", "f2", "f2", false),
  def("editor.delete", "editor", "Delete", "delete", "delete", false),
];

export const CONTEXT_LABELS: Record<ShortcutContext, string> = {
  app: "App-wide",
  terminal: "Terminal",
  files: "File browser",
  editor: "Editor",
};
