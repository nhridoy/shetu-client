import {
  CodeIcon,
  FloppyDiskIcon,
  FolderIcon,
  GearSixIcon,
  ListIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import SyncStatus from "@/components/layout/shell/SyncStatus";
import {
  isMac,
  WindowControls,
  WindowDragArea,
} from "@/components/layout/shell/TitleBar";
import SortableTab from "@/components/layout/tabs/SortableTab";
import { Button } from "@/components/ui/Button";
import VaultSelector from "@/components/vault/selector/VaultSelector";
import {
  useTerminalStore,
  workspaceLayoutSnapshot,
} from "@/stores/terminal/terminalStore";

interface HeaderProps {
  activeView: string;
  setActiveView: (view: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  onOpenSettings: () => void;
  onSaveWorkspace: () => void;
  onSavePreset: (tabId: string) => void;
  onSavePresetChanges: (tabId: string) => void;
}

export default function Header({
  activeView,
  setActiveView,
  sidebarOpen,
  setSidebarOpen,
  onOpenSettings,
  onSaveWorkspace,
  onSavePreset,
  onSavePresetChanges,
}: Readonly<HeaderProps>) {
  const navigate = useNavigate();
  const tabs = useTerminalStore((s) => s.tabs);
  const addEmptyTab = useTerminalStore((s) => s.addEmptyTab);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const activeWorkspaceId = useTerminalStore((s) => s.activeWorkspaceId);
  const isDirty = useTerminalStore(
    (s) =>
      Boolean(s.activeWorkspaceId) &&
      workspaceLayoutSnapshot(s.tabs) !== s.savedSnapshot,
  );
  const activeWorkspaceName = useTerminalStore((s) => s.activeWorkspaceName);

  const handleSaveCurrentWorkspace = () => {
    void useTerminalStore
      .getState()
      .saveCurrentWorkspace()
      .then(
        () => toast.success("Workspace saved"),
        (error) =>
          toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-10 bg-dark-900 border-b border-dark-800 flex items-center pl-2 gap-0.5">
      {isMac && <WindowControls />}
      {/* Mobile menu toggle */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="lg:hidden shrink-0 mr-1 rounded"
      >
        <ListIcon className="w-4 h-4" />
      </Button>

      {/* Vaults Tab */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setActiveView("vault");
          navigate("/hosts");
        }}
        className={`shrink-0 rounded ${
          activeView === "vault"
            ? "bg-dark-800 text-white"
            : "hover:bg-dark-800/50"
        }`}
      >
        <FolderIcon className="w-3.5 h-3.5" />
        Vaults
      </Button>
      {activeView === "vault" && <VaultSelector compact />}

      <div className="flex min-w-0 max-w-full items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* SFTP Tab */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setActiveView("sftp");
            navigate("/sftp");
          }}
          className={`shrink-0 rounded ${
            activeView === "sftp"
              ? "bg-dark-800 text-white"
              : "hover:bg-dark-800/50"
          }`}
        >
          <FolderIcon className="w-3.5 h-3.5" />
          SFTP
        </Button>

        {/* Editor Tab */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setActiveView("editor");
            navigate("/editor");
          }}
          className={`shrink-0 rounded ${
            activeView === "editor"
              ? "bg-dark-800 text-white"
              : "hover:bg-dark-800/50"
          }`}
        >
          <CodeIcon className="w-3.5 h-3.5" />
          Editor
        </Button>

        {/* Separator */}
        {tabs.length > 0 && (
          <div className="shrink-0 w-px h-4 mx-1 bg-dark-700" />
        )}

        {/* Real Tabs (sortable, powered by dnd-kit) */}
        <div className="flex items-center">
          {tabs.map((tab, index) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              index={index}
              isActive={activeView === tab.id}
              onActivate={() => {
                setActiveTab(tab.id);
                setActiveView(tab.id);
                navigate("/terminal");
              }}
              onSavePreset={onSavePreset}
              onSavePresetChanges={onSavePresetChanges}
              onClose={() => {
                const isClosingActive = activeView === tab.id;
                removeTab(tab.id);
                if (isClosingActive) {
                  const { tabs: remainingTabs } = useTerminalStore.getState();
                  if (remainingTabs.length > 0) {
                    const lastTab = remainingTabs.at(-1);
                    if (lastTab) {
                      setActiveView(lastTab.id);
                    }
                    navigate("/terminal");
                  } else {
                    setActiveView("vault");
                    navigate("/hosts");
                  }
                }
              }}
            />
          ))}
        </div>

        {/* New Tab Button */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            const newTabId = addEmptyTab();
            setActiveView(newTabId);
            navigate("/terminal");
          }}
          className="shrink-0 rounded"
          title="New Tab"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Spacer */}
      <WindowDragArea className="min-w-6 flex-1 px-0" />

      {/* Right-side actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Workspace save group (far right) */}
        {activeWorkspaceId && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="flex items-center gap-1.5 max-w-35 px-2 py-0.5 text-xs text-dark-300 bg-dark-800 rounded">
              <span className="truncate">{activeWorkspaceName}</span>
              {isDirty && (
                <span
                  className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500"
                  title="Unsaved changes"
                />
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleSaveCurrentWorkspace}
              disabled={!isDirty}
              title={
                isDirty ? "Save workspace (overwrite)" : "No unsaved changes"
              }
              className={`rounded ${
                isDirty
                  ? "text-primary-400 hover:text-white hover:bg-dark-800"
                  : "text-dark-600 cursor-default"
              }`}
            >
              <FloppyDiskIcon className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onSaveWorkspace}
              disabled={!!activeWorkspaceId}
              title={
                activeWorkspaceId
                  ? "Delete the current workspace to create a new one"
                  : "Save as new workspace"
              }
              className={`rounded ${
                activeWorkspaceId
                  ? "text-dark-600 cursor-default"
                  : "hover:text-white hover:bg-dark-800"
              }`}
            >
              <span className="relative">
                <FloppyDiskIcon className="w-3.5 h-3.5" />
                <PlusIcon className="w-2 h-2 absolute -bottom-0.5 -right-0.5" />
              </span>
            </Button>
          </div>
        )}
        {!activeWorkspaceId && tabs.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onSaveWorkspace}
            className="shrink-0 rounded"
            title="Save workspace"
          >
            <FloppyDiskIcon className="w-3.5 h-3.5" />
          </Button>
        )}

        <SyncStatus />
        <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 text-xs text-dark-500">
          <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
          <span>Connected</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          className="rounded"
          title="Settings"
        >
          <GearSixIcon className="w-4 h-4" />
        </Button>
      </div>
      {!isMac && <WindowControls />}
    </header>
  );
}
