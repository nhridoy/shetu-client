import { useDraggable } from "@dnd-kit/react";
import {
  CircleNotchIcon,
  PencilSimpleIcon,
  TrashIcon,
  WifiHighIcon,
} from "@phosphor-icons/react";
import { OsIcon } from "@/components/icons/OsIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { useModal } from "@/hooks/useModal";
import { accessibleClickHandler } from "@/lib/common/accessibleClickHandler";
import { osMeta } from "@/lib/constants/os";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { useHostPingStore } from "@/stores/hosts/hostPingStore";
import type { Host } from "@/stores/hosts/hostStore";

export function DraggableHostCard({
  host,
  isDropTarget,
  onConnect,
  onEdit,
  onDelete,
}: {
  host: Host;
  isDropTarget?: boolean;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (id: string) => void;
}) {
  const { ref, isDragging } = useDraggable({
    id: `host:${host.id}`,
    data: { type: "host-source", hostId: host.id },
  });

  const pingState = useHostPingStore((s) => s.pings[host.id]);
  const ping = useHostPingStore((s) => s.ping);

  const deleteDialog = useModal();

  return (
    // biome-ignore lint/a11y/useSemanticElements: contains nested <button> elements for edit/delete
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => onConnect(host)}
      onKeyDown={accessibleClickHandler(() => onConnect(host))}
      className={`relative p-3 transition-colors rounded-lg cursor-pointer bg-dark-800/50 hover:bg-dark-800 group ${isDragging ? "opacity-50" : ""} ${isDropTarget ? "ring-2 ring-primary-500" : ""}`}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: host.color || "#64748b" }}
        />
        <span className="text-sm font-medium text-white truncate">
          {host.name}
        </span>
      </div>
      <p className="flex items-center gap-1.5 text-dark-500 text-xs mt-1 ml-[18px] truncate">
        <OsIcon os={host.os} className="w-3 h-3 shrink-0" />
        <span className="capitalize">{osMeta(host.os).name}</span>
        <span className="text-dark-600">•</span>
        <span>SSH</span>
        <span className="text-dark-600">•</span>
        <span className="shrink-0">
          {formatRelativeTime(Number(host.createdAt))}
        </span>
      </p>
      {pingState && (
        <p className="flex items-center gap-1.5 text-xs mt-1 ml-[18px]">
          {pingState.status === "pinging" && (
            <>
              <CircleNotchIcon className="w-3 h-3 animate-spin shrink-0" />
              <span className="text-dark-500">Checking…</span>
            </>
          )}
          {pingState.status === "reachable" && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              <span className="text-emerald-400">
                {pingState.latencyMs != null
                  ? `${pingState.latencyMs} ms`
                  : "Reachable"}
              </span>
              {pingState.os && (
                <>
                  <span className="text-dark-600">•</span>
                  <OsIcon os={pingState.os} className="w-3 h-3 shrink-0" />
                </>
              )}
            </>
          )}
          {pingState.status === "unreachable" && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              <span className="text-red-400">Unreachable</span>
            </>
          )}
        </p>
      )}
      {host.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 ml-[18px]">
          {[...new Set(host.tags)].slice(0, 3).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}
      <div className="absolute flex items-center gap-1 transition-opacity opacity-0 top-2 right-2 group-hover:opacity-100">
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void ping(host.id);
          }}
          variant="ghost"
          size="icon-xs"
          className="hover:text-primary-500"
          title="Ping host"
        >
          <WifiHighIcon className="w-3 h-3" weight="bold" />
        </Button>
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(host);
          }}
          variant="ghost"
          size="icon-xs"
          className="hover:text-yellow-500"
          title="Edit host"
        >
          <PencilSimpleIcon className="w-3 h-3" weight="bold" />
        </Button>
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            deleteDialog.show();
          }}
          variant="ghost"
          size="icon-xs"
          className="hover:text-red-500"
          title="Delete host"
        >
          <TrashIcon className="w-3 h-3" weight="bold" />
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={deleteDialog.open}
        message={`Delete host "${host.name}"?`}
        onConfirm={() => {
          deleteDialog.hide();
          onDelete(host.id);
        }}
        onCancel={deleteDialog.hide}
      />
    </div>
  );
}
