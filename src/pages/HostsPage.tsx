import { useState } from "react";
import GroupForm from "@/components/hosts/forms/GroupForm";
import HostForm, { type HostData } from "@/components/hosts/forms/HostForm";
import HostsPanel from "@/components/hosts/panels/HostsPanel";
import { useModal } from "@/hooks/useModal";
import { type Group, type Host, useHostStore } from "@/stores/hosts/hostStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
export default function HostsPage() {
  const { deleteHost, deleteGroup } = useHostStore();
  const { addTab } = useTerminalStore();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [defaultGroupId, setDefaultGroupId] = useState<string | undefined>();
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);

  const hostModal = useModal();
  const groupModal = useModal();

  const handleConnect = (host: Host) => {
    addTab(host.id, host.name, {
      hostAddress: host.address,
      hostPort: host.port,
      hostUsername: host.username,
      authType: host.authType,
      keyId: host.keyId,
    });
  };

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <HostsPanel
        selectedGroupId={selectedGroupId}
        onSelectGroup={setSelectedGroupId}
        onNewGroup={(parentId) => {
          setEditingGroup(null);
          setNewGroupParentId(parentId ?? null);
          groupModal.show();
        }}
        onNewHost={(groupId) => {
          setEditingHost(null);
          setDefaultGroupId(groupId);
          hostModal.show();
        }}
        onEditGroup={(group) => {
          setEditingGroup(group);
          groupModal.show();
        }}
        onEditHost={async (host) => {
          const decrypted = await useHostStore
            .getState()
            .getDecryptedHost(host.id);
          setEditingHost(decrypted ?? host);
          hostModal.show();
        }}
        onConnect={handleConnect}
        onDeleteGroup={(id) => {
          deleteGroup(id);
          if (selectedGroupId === id) setSelectedGroupId(null);
        }}
        onDeleteHost={deleteHost}
      />

      {hostModal.open && (
        <HostForm
          host={
            editingHost
              ? ({
                  id: editingHost.id,
                  name: editingHost.name,
                  address: editingHost.address,
                  port: editingHost.port,
                  username: editingHost.username || "root",
                  authType: editingHost.authType || "password",
                  keyId: editingHost.keyId || undefined,
                  color: editingHost.color,
                  groupId: editingHost.groupId || undefined,
                  tags: editingHost.tags,
                } satisfies HostData)
              : undefined
          }
          defaultGroupId={defaultGroupId}
          onClose={() => {
            hostModal.hide();
            setEditingHost(null);
            setDefaultGroupId(undefined);
          }}
        />
      )}

      {groupModal.open && (
        <GroupForm
          group={
            editingGroup
              ? {
                  ...editingGroup,
                  parentId: editingGroup.parentId ?? undefined,
                }
              : undefined
          }
          defaultParentId={newGroupParentId || undefined}
          onClose={() => {
            groupModal.hide();
            setEditingGroup(null);
            setNewGroupParentId(null);
          }}
        />
      )}
    </div>
  );
}
