import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider, KeyboardSensor } from "@dnd-kit/react";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { toast } from "sonner";
import AppSidebar from "@/components/layout/shell/AppSidebar";
import Header from "@/components/layout/shell/Header";

import SettingsModal from "@/components/settings/modal/SettingsModal";
import WorkspaceForm from "@/components/workspaces/forms/WorkspaceForm";
import { useLayoutDragDrop } from "@/hooks/layout/useLayoutDragDrop";
import { useModal } from "@/hooks/useModal";
import { useAuthStore } from "@/stores/auth/authStore";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useSessionStore } from "@/stores/sessions/sessionStore";
import { useTabGroupStore } from "@/stores/sessions/tabGroupStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import {
  SYNC_COMPLETED_EVENT,
  TEAM_ACCESS_REVOKED_EVENT,
  useSyncStore,
} from "@/stores/sync/syncStore";
import { useSharedVaultStore } from "@/stores/teams/sharedVaultStore";
import { useTeamStore } from "@/stores/teams/teamStore";
import {
  serializePresetRoot,
  serializeWorkspaceLayout,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { useWorkspaceStore } from "@/stores/workspaces/workspaceStore";

export default function Layout() {
  const location = useLocation();
  const { fetchHosts, fetchGroups } = useHostStore();
  const { currentVaultId, fetchVaults } = useVaultStore();
  const defaultPersonalVaultId = useVaultStore(
    (state) =>
      state.vaults.find((vault) => vault.isDefault && !vault.isShared)?.id,
  );
  const isUnlocked = useAuthStore((state) => state.isUnlocked);
  const serverAuthenticated = useAuthStore(
    (state) => state.serverAuthenticated,
  );
  const startSync = useSyncStore((state) => state.start);
  const requestSync = useSyncStore((state) => state.requestSync);

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
    "/teams",
  ].includes(location.pathname);

  useEffect(() => {
    if (location.pathname === "/sftp") {
      setActiveView("sftp");
    } else if (location.pathname === "/editor") {
      setActiveView("editor");
    } else if (location.pathname === "/terminal") {
      setActiveView(useTerminalStore.getState().activeTabId ?? "terminal");
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
    if (isUnlocked) void fetchVaults();
  }, [fetchVaults, isUnlocked]);

  useEffect(() => {
    if (!isUnlocked || !defaultPersonalVaultId) return;
    void useSessionStore.getState().fetchSessions();
    const timer = window.setInterval(
      () => {
        void useSessionStore.getState().fetchSessions();
      },
      60 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
  }, [isUnlocked, defaultPersonalVaultId]);

  useEffect(() => {
    if (!isUnlocked || !serverAuthenticated) return;
    let cancelled = false;
    void (async () => {
      await useTeamStore.getState().fetchTeams();
      if (cancelled || useTeamStore.getState().error) return;
      for (const team of useTeamStore.getState().teams) {
        await useSharedVaultStore.getState().fetchSharedVaults(team.id);
        if (cancelled) return;
      }
      if (!cancelled) void useSyncStore.getState().requestAll();
    })();
    return () => {
      cancelled = true;
    };
  }, [isUnlocked, serverAuthenticated]);

  useEffect(() => {
    if (!isUnlocked) return;
    void fetchHosts(currentVaultId || undefined);
    void fetchGroups(currentVaultId || undefined);
  }, [currentVaultId, fetchHosts, fetchGroups, isUnlocked]);

  useEffect(() => {
    if (!isUnlocked || !currentVaultId) return;
    return startSync(currentVaultId);
  }, [isUnlocked, currentVaultId, startSync]);

  useEffect(() => {
    if (isUnlocked && serverAuthenticated && currentVaultId) {
      void requestSync(currentVaultId);
    }
  }, [isUnlocked, serverAuthenticated, currentVaultId, requestSync]);

  useEffect(() => {
    if (!currentVaultId) return;
    const onSyncCompleted = (event: Event) => {
      const vaultId = (event as CustomEvent<{ vaultId: string }>).detail
        ?.vaultId;
      if (vaultId !== currentVaultId) return;
      void Promise.allSettled([
        fetchVaults(),
        fetchHosts(currentVaultId),
        fetchGroups(currentVaultId),
        useKeyStore.getState().fetchKeys(currentVaultId),
        useSnippetStore.getState().fetchSnippets(currentVaultId),
        useWorkspaceStore.getState().fetchWorkspaces(currentVaultId),
        useTabGroupStore.getState().fetchTabGroups(currentVaultId),
      ]);
    };
    window.addEventListener(SYNC_COMPLETED_EVENT, onSyncCompleted);
    return () =>
      window.removeEventListener(SYNC_COMPLETED_EVENT, onSyncCompleted);
  }, [currentVaultId, fetchVaults, fetchHosts, fetchGroups]);

  useEffect(() => {
    const onRevoked = () => void fetchVaults();
    window.addEventListener(TEAM_ACCESS_REVOKED_EVENT, onRevoked);
    return () =>
      window.removeEventListener(TEAM_ACCESS_REVOKED_EVENT, onRevoked);
  }, [fetchVaults]);

  const { handleDragStart, handleDragOver, handleDragEnd } = useLayoutDragDrop({
    setActiveView,
  });

  const handlePresetFormSubmit = async (name: string) => {
    if (presetTargetTabId) {
      const tab = useTerminalStore
        .getState()
        .tabs.find((t) => t.id === presetTargetTabId);
      if (tab) {
        const created = await useTabGroupStore
          .getState()
          .createTabGroup(
            name,
            serializePresetRoot(tab.root),
            currentVaultId || undefined,
          );
        if (!created)
          throw new Error(
            useTabGroupStore.getState().error ?? "Could not save preset",
          );
        useTerminalStore
          .getState()
          .setPresetForTab(presetTargetTabId, created.id, created.name);
        return;
      }
    }
    throw new Error("Tab is no longer available");
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
            void useTerminalStore
              .getState()
              .saveCurrentPreset(tabId)
              .then(
                () => toast.success("Preset saved"),
                (error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error),
                  ),
              );
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
            onSubmit={(name) =>
              useTerminalStore
                .getState()
                .saveAsNewWorkspace(name, currentVaultId || undefined)
            }
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
      </div>
    </DragDropProvider>
  );
}
