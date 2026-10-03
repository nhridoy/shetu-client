import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { useNavigate } from "react-router";
import WorkspaceForm from "@/components/workspaces/forms/WorkspaceForm";
import WorkspaceList from "@/components/workspaces/lists/WorkspaceList";
import { useModal } from "@/hooks/useModal";
import {
  useTerminalStore,
  workspaceLayoutSnapshot,
} from "@/stores/terminal/terminalStore";
import { useVaultStore } from "@/stores/vault/vaultStore";

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const { currentVaultId } = useVaultStore();
  const formModal = useModal();

  const confirmDiscardUnsaved = async (): Promise<boolean> => {
    const { tabs, savedSnapshot, activeWorkspaceId } =
      useTerminalStore.getState();
    const isDirty = workspaceLayoutSnapshot(tabs) !== savedSnapshot;
    if (isDirty && activeWorkspaceId) {
      return await tauriConfirm(
        "This workspace has unsaved changes. Discard them?",
        { title: "Unsaved Changes", kind: "warning" },
      );
    }
    return true;
  };

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <WorkspaceList
        onSaveNew={() => formModal.show()}
        onLaunch={async (layout, id, name) => {
          if (!(await confirmDiscardUnsaved())) return;
          useTerminalStore.getState().launchWorkspace(layout, id, name);
          navigate("/terminal");
        }}
      />

      {formModal.open && (
        <WorkspaceForm
          title="Save Workspace"
          submitLabel="Save"
          onSubmit={(name) =>
            useTerminalStore
              .getState()
              .saveAsNewWorkspace(name, currentVaultId || undefined)
          }
          onClose={() => formModal.hide()}
        />
      )}
    </div>
  );
}
