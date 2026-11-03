import { useCallback, useState } from "react";
import FocusMode from "@/components/terminal/focus/FocusMode";
import PaneTree from "@/components/terminal/panes/PaneTree";
import CommandAutocomplete from "@/components/terminal/views/CommandAutocomplete";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTerminalStore } from "@/stores/terminal/terminalStore";

interface TerminalViewProps {
  onSetActiveView?: (view: string) => void;
}

export default function TerminalView({ onSetActiveView }: TerminalViewProps) {
  const { tabs, activeTabId, splitPane, removePane } = useTerminalStore();
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);

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

  const handleFocusMode = useCallback(() => {
    setIsFocusMode(!isFocusMode);
  }, [isFocusMode]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarVisible(!sidebarVisible);
    window.dispatchEvent(
      new CustomEvent("toggle-sidebar", {
        detail: { visible: !sidebarVisible },
      }),
    );
  }, [sidebarVisible]);

  const handleCommandSelect = useCallback((command: string) => {
    console.log("Execute command:", command);
    setShowCommandPalette(false);
  }, []);

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

  const handleCloseTab = useCallback(() => {
    const { activeTabId: atId, tabs: currentTabs } =
      useTerminalStore.getState();
    const tab = currentTabs.find((t) => t.id === atId);
    if (!atId || !tab?.activePaneId) return;
    removePane(atId, tab.activePaneId);
  }, [removePane]);

  const handleRestorePreset = useCallback(
    (preset: { id?: string; name?: string; layout: string }, tabId: string) => {
      useTerminalStore.getState().restorePreset(preset, tabId);
      onSetActiveView?.(tabId);
    },
    [onSetActiveView],
  );

  useKeyboardShortcuts({
    onNewTab: () => {
      const newTabId = useTerminalStore.getState().addEmptyTab();
      onSetActiveView?.(newTabId);
    },
    onCloseTab: handleCloseTab,
    onNextTab: handleNextTab,
    onPrevTab: handlePrevTab,
    onSplitHorizontal: () => handleSplit("horizontal"),
    onSplitVertical: () => handleSplit("vertical"),
    onFocusMode: handleFocusMode,
    onCommandPalette: () => setShowCommandPalette(!showCommandPalette),
    onSaveWorkspace: () => console.log("Save workspace"),
    onToggleSidebar: handleToggleSidebar,
  });

  if (!activeTab) return null;

  return (
    <FocusMode isActive={isFocusMode} onExit={() => setIsFocusMode(false)}>
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

        <CommandAutocomplete
          isVisible={showCommandPalette}
          onSelect={handleCommandSelect}
          onClose={() => setShowCommandPalette(false)}
        />
      </div>
    </FocusMode>
  );
}
