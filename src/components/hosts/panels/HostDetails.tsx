import { FolderIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { OsIcon } from "@/components/icons/OsIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { useModal } from "@/hooks/useModal";
import { osMeta } from "@/lib/constants/os";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { type Host, useHostStore } from "@/stores/hosts/hostStore";

interface HostDetailsProps {
  host: Host;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (id: string) => void;
}

export default function HostDetails({
  host,
  onConnect,
  onEdit,
  onDelete,
}: HostDetailsProps) {
  const { groups } = useHostStore();
  const groupName = host.groupId
    ? groups.find((g) => g.id === host.groupId)?.name
    : null;
  const deleteDialog = useModal();

  const handleSftpClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteDialog.show();
  };

  return (
    <>
      <Button
        type="button"
        onClick={() => onConnect(host)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onConnect(host);
        }}
        variant="ghost"
        className="gap-3 px-3 py-3 rounded-lg cursor-pointer hover:bg-dark-800 group transition-colors text-left w-full h-auto"
      >
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: host.color || "#64748b" }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-white text-sm font-medium truncate">
              {host.name}
            </p>
            {groupName && <Badge>{groupName}</Badge>}
          </div>
          <p className="text-dark-400 text-xs truncate">
            SSH •{" "}
            <span className="inline-flex items-center gap-1">
              <OsIcon os={host.os} className="w-3.5 h-3.5" />
              {osMeta(host.os).name}
            </span>{" "}
            • {formatRelativeTime(Number(host.createdAt))}
          </p>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            type="button"
            onClick={handleSftpClick}
            variant="ghost"
            size="icon"
            className="text-dark-400 hover:text-primary-500"
            title="Open SFTP"
          >
            <FolderIcon className="w-4 h-4" weight="bold" />
          </Button>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(host);
            }}
            variant="ghost"
            size="icon"
            className="text-dark-400 hover:text-yellow-500"
            title="Edit host"
          >
            <PencilSimpleIcon className="w-4 h-4" weight="bold" />
          </Button>
          <Button
            type="button"
            onClick={handleDelete}
            variant="ghost"
            size="icon"
            className="text-dark-400 hover:text-red-500"
            title="Delete host"
          >
            <TrashIcon className="w-4 h-4" weight="bold" />
          </Button>
        </div>
      </Button>

      {/* SFTP Modal */}
      {/* SFTP view would be handled by the parent Layout component */}

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message={`Delete host "${host.name}"?`}
        onConfirm={() => {
          deleteDialog.hide();
          onDelete(host.id);
        }}
        onCancel={deleteDialog.hide}
      />
    </>
  );
}
