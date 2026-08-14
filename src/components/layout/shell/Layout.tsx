import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, KeyboardSensor } from "@dnd-kit/react";
import { FolderIcon, TerminalIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import AppSidebar from "@/components/layout/shell/AppSidebar";
import Header from "@/components/layout/shell/Header";
import { TabPreview } from "@/components/layout/tabs/SortableTab";
import SettingsModal from "@/components/settings/modal/SettingsModal";
import WorkspaceForm from "@/components/workspaces/forms/WorkspaceForm";
import { useLayoutDragDrop } from "@/hooks/layout/useLayoutDragDrop";
import { useModal } from "@/hooks/useModal";
import { getStatusColor } from "@/lib/common/connectionStatus";
import { useHostStore } from "@/stores/hosts/hostStore";
import {
  findLeaf,
  serializeWorkspaceLayout,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export default function Layout() {
  const location = useLocation();
  const { fetchHosts, fetchGroups } = useHostStore();
  const { currentVaultId, fetchVaults } = useVaultStore();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [activeView, setActiveView] = useState("vault");

  const workspaceModal = useModal();
  const presetModal = useModal();
  const settingsModal = useModal();
  const [presetTargetTabId, setPresetTargetTabId] = useState<string | null>(
    null,
  );

  const isVaultPage = [
    "/hosts",
    "/workspaces",
    "/snippets",
    "/keys",
    "/history",
  ].includes(location.pathname);

  useEffect(() => {
    if (location.pathname === "/sftp") {
      setActiveView("sftp");
    } else if (location.pathname === "/editor") {
      setActiveView("editor");
    } else if (location.pathname === "/terminal") {
      // keep current activeView for terminal
    } else if (isVaultPage) {
      setActiveView("vault");
    }
  }, [location.pathname, isVaultPage]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    // Vaults are loaded once: switching vaults never changes the vault list
    // (store mutations update it in memory), so it must not refire per switch.
    fetchVaults();
  }, [fetchVaults]);

  useEffect(() => {
    fetchHosts(currentVaultId || undefined);
    fetchGroups(currentVaultId || undefined);
  }, [currentVaultId, fetchHosts, fetchGroups]);

  const {
    hosts,
    groups,
    tabs,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useLayoutDragDrop({ setActiveView });

  const handlePresetFormSubmit = async (name: string) => {
    if (presetTargetTabId) {
      const tab = useTerminalStore
        .getState()
        .tabs.find((t) => t.id === presetTargetTabId);
      if (tab) {
        const { useTabGroupStore } = await import(
          "@/stores/sessions/tabGroupStore"
        );
        const created = await useTabGroupStore
          .getState()
          .createTabGroup(name, tab.root, currentVaultId || undefined);
        if (created) {
          useTerminalStore
            .getState()
            .setPresetForTab(presetTargetTabId, created.id, created.name);
        }
      }
    }
    presetModal.hide();
    setPresetTargetTabId(null);
  };

  return (
    <DragDropProvider
      sensors={(defaults) => [
        ...defaults.filter(
          (sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor,
        ),
        PointerSensor.configure({
          activationConstraints: (event) => {
            if (event.pointerType === "touch") {
              return [
                new PointerActivationConstraints.Delay({
                  value: 250,
                  tolerance: 5,
                }),
              ];
            }
            return [new PointerActivationConstraints.Distance({ value: 5 })];
          },
        }),
      ]}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="min-h-screen bg-dark-950">
        <Header
          activeView={activeView}
          setActiveView={setActiveView}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          onOpenSettings={settingsModal.show}
          onSaveWorkspace={() => {
            const currentTabs = useTerminalStore.getState().tabs;
            const payload = serializeWorkspaceLayout(currentTabs);
            if (payload.tabs.length === 0) return;
            workspaceModal.show();
          }}
          onSavePreset={(tabId) => {
            setPresetTargetTabId(tabId);
            presetModal.show();
          }}
          onSavePresetChanges={(tabId) => {
            useTerminalStore.getState().saveCurrentPreset(tabId);
          }}
        />

        {isVaultPage && (
          <AppSidebar
            isOpen={sidebarOpen}
            isMobile={isMobile}
            onClose={() => setSidebarOpen(false)}
            onOpenSettings={settingsModal.show}
          />
        )}

        {isVaultPage && isMobile && sidebarOpen && (
          <button
            type="button"
            aria-label="Close sidebar"
            className="fixed bottom-0 left-0 right-0 z-30 top-10 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main
          className={`pt-10 h-screen flex flex-col ${
            isVaultPage ? "lg:ml-72" : ""
          } ${isVaultPage && isMobile && sidebarOpen ? "ml-72" : ""}`}
        >
          <Outlet />
        </main>

        {workspaceModal.open && (
          <WorkspaceForm
            title="Save Workspace"
            submitLabel="Save"
            onSubmit={(name) => {
              useTerminalStore
                .getState()
                .saveAsNewWorkspace(name, currentVaultId || undefined);
              workspaceModal.hide();
            }}
            onClose={() => workspaceModal.hide()}
          />
        )}

        {presetModal.open && (
          <WorkspaceForm
            title="Save Quick Preset"
            submitLabel="Save"
            initialName=""
            onSubmit={handlePresetFormSubmit}
            onClose={() => {
              presetModal.hide();
              setPresetTargetTabId(null);
            }}
          />
        )}

        {settingsModal.open && (
          <SettingsModal onClose={() => settingsModal.hide()} />
        )}

        <DragOverlay>
          {(source) => {
            if (source.data?.type === "pane-source") {
              const tab = tabs.find((t) => t.id === source.data.tabId);
              const pane = tab ? findLeaf(tab.root, source.data.paneId) : null;
              const statusClass = getStatusColor(
                pane?.connectionStatus ?? "idle",
              );
              return (
                <div className="w-60 p-3 bg-dark-800 rounded-lg shadow-xl opacity-90 border border-dark-600">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${statusClass}`}
                    />
                    <TerminalIcon className="w-4 h-4 text-primary-400 shrink-0" />
                    <span className="text-sm font-medium text-white truncate">
                      {pane?.hostName || "Empty pane"}
                    </span>
                  </div>
                </div>
              );
            }
            if (source.data?.type === "host") {
              return null;
            }
            if (source.data?.type === "group-source") {
              const group = groups.find((g) => g.id === source.data.groupId);
              if (!group) return null;
              return (
                <div className="w-60 p-3 bg-dark-800 rounded-lg shadow-xl opacity-90 border border-dark-600">
                  <div className="flex items-center gap-2">
                    <FolderIcon className="w-4 h-4 text-primary-400 shrink-0" />
                    <span className="text-sm font-medium text-white truncate">
                      {group.name}
                    </span>
                  </div>
                </div>
              );
            }
            const tab = tabs.find((t) => t.id === source.id);
            if (!tab) return null;
            return <TabPreview tab={tab} />;
          }}
        </DragOverlay>
      </div>
    </DragDropProvider>
  );
}
