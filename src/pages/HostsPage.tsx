import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import GroupForm from "@/components/hosts/forms/GroupForm";
import HostForm, { type HostData } from "@/components/hosts/forms/HostForm";
import SshConfigImportModal from "@/components/hosts/modals/SshConfigImportModal";
import HostsPanel from "@/components/hosts/panels/HostsPanel";
import { useModal } from "@/hooks/useModal";
import { openGroupId } from "@/lib/hosts/helpers";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";

type Panel =
  | { kind: "host"; id?: string; defaultGroupId?: string; host?: Host }
  | { kind: "group"; id?: string; parentId?: string | null };

/** Resolves false when the user keeps editing the open panel. */
const confirmLeave = () => useUnsavedChanges.getState().confirmLeave();

export default function HostsPage() {
  const { groups, deleteHost, deleteGroup } = useHostStore();
  const { addTab } = useTerminalStore();
  const navigate = useNavigate();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const openGroup = openGroupId(groups, selectedGroupId);
  const [panel, setPanel] = useState<Panel | null>(null);
  // Bumped on every open so the form remounts with a fresh baseline.
  const [panelKey, setPanelKey] = useState(0);
  const importModal = useModal();

  const openSeq = useRef(0);
  const openPanel = async (next: Panel | (() => Promise<Panel>)) => {
    const seq = ++openSeq.current;
    const resolved = typeof next === "function" ? await next() : next;
    // Ask after loading so edits typed meanwhile are covered; drop superseded opens.
    if (seq !== openSeq.current || !(await confirmLeave())) return;
    if (seq !== openSeq.current) return;
    setPanel(resolved);
    setPanelKey((k) => k + 1);
  };
  const closePanel = () => setPanel(null);
  const editingGroup =
    panel?.kind === "group" && panel.id
      ? groups.find((g) => g.id === panel.id)
      : undefined;

  const handleConnect = async (host: Host) => {
    if (!(await confirmLeave())) return;
    addTab(host.id, host.name, {
      hostAddress: host.address,
      hostPort: host.port,
      hostUsername: host.username,
      authType: host.authType,
      keyId: host.keyId,
    });
    navigate("/terminal");
  };

  return (
    <div className="relative flex flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <HostsPanel
          // Remount per group so search and tag filters reset.
          key={openGroup ?? "all"}
          selectedGroupId={openGroup}
          onSelectGroup={setSelectedGroupId}
          onNewGroup={(parentId) =>
            openPanel({ kind: "group", parentId: parentId ?? null })
          }
          onNewHost={(groupId) =>
            openPanel({ kind: "host", defaultGroupId: groupId })
          }
          onImport={importModal.show}
          onEditGroup={(group) => openPanel({ kind: "group", id: group.id })}
          onEditHost={(host) =>
            openPanel(async () => ({
              kind: "host",
              id: host.id,
              host:
                (await useHostStore
                  .getState()
                  .getDecryptedHost(host.id)
                  .catch(() => undefined)) ?? host,
            }))
          }
          onConnect={handleConnect}
          onDeleteGroup={(id) => {
            deleteGroup(id);
            if (selectedGroupId === id) setSelectedGroupId(null);
            if (panel?.kind === "group" && panel.id === id) closePanel();
          }}
          onDeleteHost={(id) => {
            deleteHost(id);
            if (panel?.kind === "host" && panel.id === id) closePanel();
          }}
        />
      </div>

      {panel?.kind === "host" && (
        <HostForm
          key={panelKey}
          host={
            panel.host
              ? ({
                  id: panel.host.id,
                  name: panel.host.name,
                  address: panel.host.address,
                  port: panel.host.port,
                  username: panel.host.username ?? "",
                  authType: panel.host.authType || "password",
                  password: panel.host.password,
                  keyId: panel.host.keyId || undefined,
                  jumpHostId: panel.host.jumpHostId ?? null,
                  keepaliveSecs: panel.host.keepaliveSecs,
                  forwardAgent: panel.host.forwardAgent,
                  env: panel.host.env,
                  startup: panel.host.startup,
                  color: panel.host.color,
                  groupId: panel.host.groupId || undefined,
                  tags: panel.host.tags,
                } satisfies HostData)
              : undefined
          }
          defaultGroupId={panel.defaultGroupId}
          onClose={closePanel}
        />
      )}

      {importModal.open && (
        <SshConfigImportModal groupId={openGroup} onClose={importModal.hide} />
      )}

      {panel?.kind === "group" && (!panel.id || editingGroup) && (
        <GroupForm
          key={panelKey}
          group={
            editingGroup
              ? {
                  ...editingGroup,
                  parentId: editingGroup.parentId ?? undefined,
                }
              : undefined
          }
          // Re-checked on every render: the parent can be deleted while the form is open.
          defaultParentId={
            openGroupId(groups, panel.parentId ?? null) ?? undefined
          }
          onClose={closePanel}
        />
      )}
    </div>
  );
}
