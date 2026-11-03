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

const VIEWS = [
  { id: "vault", path: "/hosts", label: "Vaults", Icon: FolderIcon },
  { id: "sftp", path: "/sftp", label: "SFTP", Icon: FolderIcon },
  { id: "editor", path: "/editor", label: "Editor", Icon: CodeIcon },
] as const;

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
    <header
      className={`chrome fixed top-0 left-0 right-0 z-50 h-[var(--toolbar-height)] bg-dark-900 border-b border-dark-800 flex items-center gap-1 ${isMac ? "pr-2" : "pl-2"}`}
    >
      {isMac && <WindowControls />}
      {/* Mobile menu toggle */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="lg:hidden shrink-0 mr-1"
        aria-label="Toggle sidebar"
      >
        <ListIcon className="w-4 h-4" />
      </Button>

      <fieldset
        aria-label="View"
        className="m-0 flex h-7 min-w-0 shrink-0 items-center rounded-md border-0 bg-dark-800 p-0.5"
      >
        {VIEWS.map(({ id, path, label, Icon }) => {
          const selected = activeView === id;
          return (
            <Button
              key={id}
              type="button"
              aria-pressed={selected}
              variant="ghost"
              size="sm"
              onClick={() => {
                setActiveView(id);
                navigate(path);
              }}
              className={`h-6 rounded-[5px] ${
                selected
                  ? "bg-dark-600 text-white shadow-sm hover:bg-dark-600"
                  : "text-dark-400 hover:bg-transparent"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Button>
          );
        })}
      </fieldset>
      {activeView === "vault" && <VaultSelector compact />}

      <div className="flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
          className="shrink-0"
          title="New tab"
          aria-label="New tab"
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
            <span className="flex items-center gap-1.5 max-w-35 h-6 px-2 text-xs text-dark-300 bg-dark-800 rounded-md">
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
              aria-label="Save workspace"
              className={`${
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
              aria-label="Save as new workspace"
              className={`${
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
            className="shrink-0"
            title="Save workspace"
            aria-label="Save workspace"
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
          title="Settings"
          aria-label="Settings"
        >
          <GearSixIcon className="w-4 h-4" />
        </Button>
      </div>
      {!isMac && <WindowControls />}
    </header>
  );
}
