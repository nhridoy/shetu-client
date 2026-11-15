import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import PaneTree from "@/components/terminal/panes/PaneTree";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useShortcutContext } from "@/hooks/useShortcutContext";
import { toggleTabBroadcast } from "@/lib/terminal/broadcast";
import { openFind } from "@/lib/terminal/findCommand";
import {
  openCommandPalette,
  type PaletteItem,
  pickPaletteItem,
  resolvePaletteCommand,
  runInAllTabs,
  setTerminalSnippetPicker,
} from "@/lib/terminal/paletteCommand";
import { insertIntoPane } from "@/lib/terminal/sessionManager";
import { dispatchAppAction } from "@/lib/window/menuActions";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { askSnippetVariables } from "@/stores/snippets/snippetVariablesStore";
import {
  type LeafNode,
  type PaneNode,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";

function findLeaf(node: PaneNode, id: string): LeafNode | undefined {
  if (node.type === "leaf") return node.id === id ? node : undefined;
  for (const child of node.children) {
    const leaf = findLeaf(child, id);
    if (leaf) return leaf;
  }
  return undefined;
}

interface TerminalViewProps {
  onSetActiveView?: (view: string) => void;
}

export default function TerminalView({ onSetActiveView }: TerminalViewProps) {
  const { tabs, activeTabId, splitPane } = useTerminalStore();

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const handleNextTab = useCallback(() => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex < tabs.length - 1) {
      const nextTab = tabs[currentIndex + 1];
      useTerminalStore.getState().setActiveTab(nextTab.id);
      onSetActiveView?.(nextTab.id);
    } else if (tabs.length > 0) {
      const firstTab = tabs[0];
      useTerminalStore.getState().setActiveTab(firstTab.id);
      onSetActiveView?.(firstTab.id);
    }
  }, [tabs, activeTabId, onSetActiveView]);

  const handlePrevTab = useCallback(() => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex > 0) {
      const prevTab = tabs[currentIndex - 1];
      useTerminalStore.getState().setActiveTab(prevTab.id);
      onSetActiveView?.(prevTab.id);
    } else if (tabs.length > 0) {
      const lastTab = tabs[tabs.length - 1];
      useTerminalStore.getState().setActiveTab(lastTab.id);
      onSetActiveView?.(lastTab.id);
    }
  }, [tabs, activeTabId, onSetActiveView]);

  useShortcutContext("terminal");

  const handleCommandSelect = useCallback(
    async (item: PaletteItem, run: boolean, all: boolean): Promise<boolean> => {
      if (all) {
        const resolved = await resolvePaletteCommand(item, {
          decryptSnippet: (id) =>
            useSnippetStore.getState().getDecryptedSnippet(id),
          askVariables: askSnippetVariables,
        });
        if (resolved.status !== "ok") {
          if (resolved.status === "decrypt-failed")
            toast.error("Couldn't load this snippet");
          return false;
        }
        const { ran, local } = runInAllTabs(resolved.command, {
          tabs: useTerminalStore.getState().tabs,
          insert: insertIntoPane,
        });
        if (ran === 0) {
          toast.error("No connected terminals");
          return false;
        }
        toast.success(
          `Ran in ${ran} terminal${ran === 1 ? "" : "s"}${local ? ` (${local} local)` : ""}`,
        );
        return true;
      }
      const activeTab = () => {
        const { tabs: currentTabs, activeTabId: atId } =
          useTerminalStore.getState();
        return currentTabs.find((t) => t.id === atId);
      };
      const result = await pickPaletteItem(item, run, {
        activePaneId: activeTab()?.activePaneId ?? null,
        // Reads the live store: it is checked again after decryption.
        isConnected: (paneId) => {
          const tab = activeTab();
          return (
            !!tab &&
            findLeaf(tab.root, paneId)?.connectionStatus === "connected"
          );
        },
        decryptSnippet: (id) =>
          useSnippetStore.getState().getDecryptedSnippet(id),
        insert: insertIntoPane,
        askVariables: askSnippetVariables,
      });
      const runKey = navigator.platform.includes("Mac") ? "Cmd" : "Ctrl";
      if (result === "ok") return true;
      if (result === "cancelled") return false;
      if (result === "no-pane") toast.error("Open a terminal first");
      else if (result === "not-connected")
        toast.error("This terminal isn't connected");
      else if (result === "empty") toast.error("This snippet is empty");
      else if (result === "unsafe-multiline")
        toast.error(
          `This shell would run each line. Use ${runKey}+Enter to run it.`,
        );
      else toast.error("Couldn't load this snippet");
      return false;
    },
    [],
  );
  // Palette snippet picks land in this view's active pane while it is open.
  useEffect(
    () => setTerminalSnippetPicker(handleCommandSelect),
    [handleCommandSelect],
  );

  const handleSplit = useCallback(
    (direction: "horizontal" | "vertical") => {
      const { activeTabId: atId, tabs: currentTabs } =
        useTerminalStore.getState();
      const tab = currentTabs.find((t) => t.id === atId);
      if (!atId || !tab?.activePaneId) return;
      splitPane(atId, tab.activePaneId, direction);
    },
    [splitPane],
  );

  const handleRestorePreset = useCallback(
    (preset: { id?: string; name?: string; layout: string }, tabId: string) => {
      useTerminalStore.getState().restorePreset(preset, tabId);
      onSetActiveView?.(tabId);
    },
    [onSetActiveView],
  );

  useKeyboardShortcuts({
    // Routed through Layout so the toolbar and routing stay in sync.
    onNewTab: () => dispatchAppAction("new-tab"),
    onCloseTab: () => dispatchAppAction("close-tab"),
    onNextTab: handleNextTab,
    onPrevTab: handlePrevTab,
    onSplitHorizontal: () => handleSplit("horizontal"),
    onSplitVertical: () => handleSplit("vertical"),
    onCommandPalette: () => openCommandPalette("snippets"),
    onFind: openFind,
    onBroadcast: () => {
      const id = useTerminalStore.getState().activeTabId;
      if (id) toggleTabBroadcast(id);
    },
  });

  if (!activeTab) return null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* All tabs rendered (kept mounted so SSH sessions persist); only active shown */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-dark-950">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${tab.id === activeTabId ? "" : "opacity-0 pointer-events-none"}`}
          >
            <PaneTree
              tabId={tab.id}
              node={tab.root}
              activePaneId={tab.activePaneId}
              isActiveTab={tab.id === activeTabId}
              onRestorePreset={handleRestorePreset}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
