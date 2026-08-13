import {
  FileIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { EmptyActionState } from "@/components/ui/EmptyActionState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import WorkspaceForm from "@/components/workspaces/forms/WorkspaceForm";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import {
  type PaneNode,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { useWorkspaceStore } from "@/stores/workspaces/workspaceStore";

interface WorkspaceListProps {
  onLaunch: (tabId: string) => void;
  onSaveNew: () => void;
}

function previewFromLayout(layoutStr: string): {
  tabCount: number;
  hosts: string[];
} {
  try {
    const layout = JSON.parse(layoutStr);
    const tabs: { root: PaneNode }[] = Array.isArray(layout)
      ? layout
      : layout.tabs || [];
    const hosts: string[] = [];
    tabs.forEach((tab) => {
      const collect = (node: PaneNode) => {
        if (!node) return;
        if (node.type === "leaf") {
          if (node.hostName) hosts.push(node.hostName);
        } else if (node.children) {
          node.children.forEach(collect);
        }
      };
      collect(tab.root);
    });
    return { tabCount: tabs.length, hosts };
  } catch {
    return { tabCount: 0, hosts: [] };
  }
}

export default function WorkspaceList({
  onLaunch,
  onSaveNew,
}: WorkspaceListProps) {
  const { workspaces, fetchWorkspaces, renameWorkspace, deleteWorkspace } =
    useWorkspaceStore();
  const currentVaultId = useVaultStore((s) => s.currentVaultId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameModal = useModal();
  const deleteDialog = useModal();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  useEffect(() => {
    fetchWorkspaces(currentVaultId ?? undefined);
  }, [fetchWorkspaces, currentVaultId]);

  // How many currently-open tabs have at least one connected pane. Used to
  // disable "New Workspace" until there is a real group to save.
  const connectedTabCount = useTerminalStore((s) =>
    s.tabs.reduce((acc, t) => {
      const has = (node: PaneNode): boolean =>
        node.type === "leaf" ? !!node.hostId : node.children.some(has);
      return acc + (has(t.root) ? 1 : 0);
    }, 0),
  );
  const activeWorkspaceId = useTerminalStore((s) => s.activeWorkspaceId);
  // "New Workspace" only when there are 2+ connected tabs AND no workspace is
  // currently active (created workspaces must first be deleted to make a new one).
  const canSave = connectedTabCount >= 2 && !activeWorkspaceId;

  // Launch a saved workspace: rebuild its tabs and switch to the terminal view.
  const handleLaunch = (layoutStr: string, id: string, name: string) => {
    try {
      const layout = JSON.parse(layoutStr);
      useTerminalStore.getState().launchWorkspace(layout, id, name);
      const firstTabId = useTerminalStore.getState().activeTabId;
      if (firstTabId) onLaunch(firstTabId);
    } catch (e) {
      console.error("Failed to launch workspace:", e);
    }
  };

  const openRename = (id: string) => {
    setRenamingId(id);
    renameModal.show();
  };

  const handleRenameSubmit = (name: string) => {
    if (renamingId) renameWorkspace(renamingId, name);
    renameModal.hide();
    setRenamingId(null);
  };

  const handleDelete = (id: string) => {
    setDeleteTargetId(id);
    deleteDialog.show();
  };

  const confirmDeleteAction = () => {
    deleteDialog.hide();
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    const activeId = useTerminalStore.getState().activeWorkspaceId;
    deleteWorkspace(id);
    if (activeId && activeId === id) {
      useTerminalStore.setState({
        activeWorkspaceId: null,
        activeWorkspaceName: null,
        isDirty: false,
        savedSnapshot: "",
      });
    }
  };

  return (
    <div className="flex-1 p-4 space-y-6 overflow-y-auto">
      {/* Workspaces Section */}
      <div>
        <SectionHeader
          title="Workspaces"
          level="h3"
          className="text-sm tracking-wider uppercase text-dark-400 mb-3"
        >
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onSaveNew}
            disabled={!canSave}
            title={
              canSave
                ? "Save current layout as a new workspace"
                : activeWorkspaceId
                  ? "Delete the current workspace first"
                  : "Open at least 2 connected terminals"
            }
            className="rounded disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-3 h-3" weight="bold" />
            New Workspace
          </Button>
        </SectionHeader>

        {workspaces.length === 0 ? (
          <EmptyActionState
            icon={FileIcon}
            message="No workspaces yet — open terminals and click the save icon to create one"
            onClick={onSaveNew}
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {workspaces.map((ws) => {
              const { tabCount, hosts } = previewFromLayout(ws.layout);
              return (
                // biome-ignore lint/a11y/useSemanticElements: workspace card contains nested button elements
                <div
                  key={ws.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleLaunch(ws.layout, ws.id, ws.name)}
                  onKeyDown={accessibleClickHandler(() =>
                    handleLaunch(ws.layout, ws.id, ws.name),
                  )}
                  className="relative p-3 transition-colors rounded-lg cursor-pointer bg-dark-800/50 hover:bg-dark-800 border border-primary-500/10 group"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg bg-primary-600">
                      <FileIcon className="w-4 h-4 text-white" weight="bold" />
                    </div>
                    <span className="flex-1 text-sm font-medium text-white truncate">
                      {ws.name}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-dark-500">
                    {tabCount} tab{tabCount === 1 ? "" : "s"}
                    {hosts.length > 0 &&
                      ` • ${hosts.length} connection${hosts.length === 1 ? "" : "s"}`}
                  </p>
                  {hosts.length > 0 && (
                    <p className="mt-1 text-xs text-dark-500 truncate">
                      {hosts.slice(0, 3).join(", ")}
                      {hosts.length > 3 ? ` +${hosts.length - 3}` : ""}
                    </p>
                  )}
                  <div className="absolute flex items-center gap-1 transition-opacity opacity-0 top-2 right-2 group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRename(ws.id);
                      }}
                      className="rounded"
                      title="Rename workspace"
                    >
                      <PencilSimpleIcon className="w-3 h-3" weight="bold" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(ws.id);
                      }}
                      className="hover:text-red-500 rounded"
                      title="Delete workspace"
                    >
                      <TrashIcon className="w-3 h-3" weight="bold" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {renameModal.open && (
        <WorkspaceForm
          title="Rename Workspace"
          initialName={workspaces.find((w) => w.id === renamingId)?.name || ""}
          submitLabel="Rename"
          onSubmit={handleRenameSubmit}
          onClose={() => {
            renameModal.hide();
            setRenamingId(null);
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message="Delete this workspace? This cannot be undone."
        onConfirm={confirmDeleteAction}
        onCancel={() => {
          deleteDialog.hide();
          setDeleteTargetId(null);
        }}
      />
    </div>
  );
}
