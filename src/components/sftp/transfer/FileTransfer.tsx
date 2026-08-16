import {
  CheckIcon,
  DownloadSimpleIcon,
  LightningIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { useSftpStore } from "@/stores/sftp/sftpStore";

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024)
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileTransfer() {
  const transfers = useSftpStore((s) => s.transfers);
  const removeTransfer = useSftpStore((s) => s.removeTransfer);
  const clearCompleted = useSftpStore((s) => s.clearCompletedTransfers);

  const handleCancel = useCallback(
    async (transferId: string, sessionId?: string) => {
      if (sessionId) {
        await invoke("sftp_cancel_transfer", {
          sessionId,
          transferId,
        }).catch(() => {});
      }
      removeTransfer(transferId);
    },
    [removeTransfer],
  );

  const activeTransfers = transfers.filter(
    (t) => t.status === "active" || t.status === "pending",
  );
  const completedTransfers = transfers.filter((t) => t.status === "complete");

  if (transfers.length === 0) return null;

  return (
    <div className="border-t border-dark-700 bg-dark-900 max-h-48 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-dark-700 flex items-center justify-between text-xs shrink-0">
        <div className="flex items-center gap-2 text-dark-300">
          <LightningIcon
            className="w-3.5 h-3.5 text-primary-400"
            weight="bold"
          />
          <span>Transfers</span>
          {activeTransfers.length > 0 && (
            <span className="text-primary-400">
              {activeTransfers.length} active
            </span>
          )}
        </div>
        {completedTransfers.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearCompleted}>
            Clear done ({completedTransfers.length})
          </Button>
        )}
      </div>

      {/* Transfer list */}
      <div className="overflow-y-auto flex-1">
        {transfers.map((t) => (
          <div
            key={t.id}
            className="px-3 py-1.5 border-b border-dark-800 last:border-0 flex items-center gap-2 text-xs"
          >
            {/* Direction icon */}
            {t.direction === "upload" ? (
              <UploadSimpleIcon
                className="w-3.5 h-3.5 text-green-400 shrink-0"
                weight="bold"
              />
            ) : (
              <DownloadSimpleIcon
                className="w-3.5 h-3.5 text-blue-400 shrink-0"
                weight="bold"
              />
            )}

            {/* Filename */}
            <span className="text-white truncate flex-1">{t.fileName}</span>
            {t.status === "active" && t.size > 0 && (
              <span className="text-dark-500 text-[10px] shrink-0">
                {formatBytes(t.transferred)} / {formatBytes(t.size)}
              </span>
            )}

            {/* Status */}
            {t.status === "active" && (
              <div className="flex items-center gap-2">
                <div className="w-16 bg-dark-700 rounded-full h-1">
                  <div
                    className="bg-primary-500 h-1 rounded-full transition-all"
                    style={{ width: `${Math.round(t.progress * 100)}%` }}
                  />
                </div>
                <span className="text-dark-400 w-8 text-right">
                  {Math.round(t.progress * 100)}%
                </span>
                {t.speed ? (
                  <span className="text-dark-500 w-20 text-right">
                    {formatSpeed(t.speed)}
                  </span>
                ) : null}
              </div>
            )}
            {t.status === "pending" && (
              <span className="text-dark-400">Queued</span>
            )}
            {t.status === "complete" && (
              <CheckIcon
                className="w-3.5 h-3.5 text-green-400 shrink-0"
                weight="bold"
              />
            )}
            {t.status === "error" && (
              <span className="text-red-400 truncate max-w-30" title={t.error}>
                {t.error || "Failed"}
              </span>
            )}

            {/* Remove */}
            {t.status === "active" || t.status === "pending" ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => handleCancel(t.id, t.sessionId)}
                title="Cancel transfer"
              >
                <XIcon className="w-3 h-3 text-red-400" weight="bold" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeTransfer(t.id)}
              >
                <XIcon className="w-3 h-3" weight="bold" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
