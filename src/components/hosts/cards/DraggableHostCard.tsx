import { useSortable } from "@dnd-kit/react/sortable";
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
  index,
  onConnect,
  onEdit,
  onDelete,
}: {
  host: Host;
  index: number;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (id: string) => void;
}) {
  const { ref } = useSortable({
    id: host.id,
    index,
    data: { type: "host", hostId: host.id },
  });

  const pingState = useHostPingStore((s) => s.pings[host.id]);
  const ping = useHostPingStore((s) => s.ping);

  const deleteDialog = useModal();

  const initial = host.name?.charAt(0)?.toUpperCase() || "?";
  const hostColor = host.color || "#64748b";

  return (
    // biome-ignore lint/a11y/useSemanticElements: contains nested <button> elements
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => onConnect(host)}
      onKeyDown={accessibleClickHandler(() => onConnect(host))}
      className="relative overflow-hidden p-3 transition-colors rounded-lg cursor-pointer bg-dark-800/50 hover:bg-dark-800 border border-primary-500/10 group"
    >
      <div
        className="absolute top-0 left-0 w-56 h-56 -translate-x-8 -translate-y-8 rounded-full pointer-events-none"
        style={{
          background: `radial-gradient(circle at 24px 24px, ${hostColor}50 0%, ${hostColor}15 30%, transparent 60%)`,
        }}
      />
      <div className="relative z-10 flex items-center gap-1.5">
        <div
          className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0"
          style={{
            backgroundColor: `${hostColor}33`,
            color: hostColor,
            border: `1px solid ${hostColor}`,
          }}
        >
          {initial}
        </div>
        <span className="text-sm font-medium text-white truncate">
          {host.name}
        </span>
      </div>

      <p className="relative z-10 flex items-center gap-1.5 text-dark-500 text-xs mt-1.5">
        <span className="capitalize">{osMeta(host.os).name}</span>
        <span className="text-dark-600">•</span>
        <span>SSH</span>
        <span className="text-dark-600">•</span>
        <span className="shrink-0">
          {formatRelativeTime(Number(host.createdAt))}
        </span>
      </p>

      <p className="relative z-10 flex items-center gap-1.5 text-xs mt-1">
        {!pingState && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-dark-600 shrink-0" />
            <span className="text-dark-600">—</span>
          </>
        )}
        {pingState?.status === "pinging" && (
          <>
            <CircleNotchIcon className="w-3 h-3 animate-spin shrink-0 text-dark-500" />
            <span className="text-dark-500">Checking…</span>
          </>
        )}
        {pingState?.status === "reachable" && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-emerald-400">
              {pingState.latencyMs != null
                ? `Reachable · ${pingState.latencyMs}ms`
                : "Reachable"}
            </span>
          </>
        )}
        {pingState?.status === "unreachable" && (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
            <span className="text-red-400">Unreachable</span>
          </>
        )}
      </p>

      {host.tags.length > 0 && (
        <div className="relative z-10 flex gap-1 mt-1.5">
          {[...new Set(host.tags)].slice(0, 3).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}

      <div className="absolute -bottom-3 -right-3 pointer-events-none opacity-30 group-hover:opacity-40 transition-opacity">
        <OsIcon os={host.os} className="w-20 h-20 text-dark-400" />
      </div>

      <div className="absolute flex items-center gap-0.5 transition-opacity opacity-0 top-1.5 right-1.5 group-hover:opacity-100 z-20">
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
