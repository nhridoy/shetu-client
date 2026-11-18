import {
  ArrowClockwiseIcon,
  CheckIcon,
  CopySimpleIcon,
  DownloadSimpleIcon,
  LightningIcon,
  PauseIcon,
  PlayIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  cancelTransfer,
  pauseTransfer,
  resumeAllTransfers,
  resumeTransfer,
  retryTransfer,
  type TransferJob,
} from "@/lib/sftp/transfers";
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

const MAX_ATTEMPTS = 5;

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function hostLabel(job: TransferJob): string {
  return job.src.host?.host ?? job.dest.host?.host ?? "host";
}

/** Status line for rows that aren't showing a progress bar. */
function statusLabel(job: TransferJob, now: number): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "paused":
      return "Paused";
    case "failed":
      return job.error || "Failed";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "waiting":
      if (job.waitReason === "unlock") return "Waiting for unlock";
      if (job.waitReason === "host") return `Waiting for ${hostLabel(job)}`;
      return `Retrying in ${Math.max(0, Math.ceil(((job.nextRetryAt ?? now) - now) / 1000))} s (${job.attempt} of ${MAX_ATTEMPTS})`;
    default:
      return "";
  }
}

function KindIcon({ job }: { job: TransferJob }) {
  if (job.kind === "upload")
    return (
      <UploadSimpleIcon
        className="w-3.5 h-3.5 text-green-400 shrink-0"
        weight="bold"
      />
    );
  if (job.kind === "download")
    return (
      <DownloadSimpleIcon
        className="w-3.5 h-3.5 text-blue-400 shrink-0"
        weight="bold"
      />
    );
  return (
    <CopySimpleIcon
      className="w-3.5 h-3.5 text-yellow-400 shrink-0"
      weight="bold"
    />
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

/** Re-renders every second while a retry countdown is on screen. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

export default function FileTransfer() {
  const transfers = useSftpStore((s) => s.transfers);
  const clearCompleted = useSftpStore((s) => s.clearCompletedTransfers);
  const now = useNow(
    transfers.some((t) => t.status === "waiting" && t.waitReason === "retry"),
  );

  const activeCount = transfers.filter(
    (t) => t.status === "active" || t.status === "queued",
  ).length;
  const finishedCount = transfers.filter(
    (t) => t.status === "done" || t.status === "cancelled",
  ).length;
  const anyPaused = transfers.some((t) => t.status === "paused");

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
          {activeCount > 0 && (
            <span className="text-primary-400">{activeCount} active</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {anyPaused && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void resumeAllTransfers()}
            >
              Resume all
            </Button>
          )}
          {finishedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clearCompleted()}
            >
              Clear done ({finishedCount})
            </Button>
          )}
        </div>
      </div>

      {/* Transfer list */}
      <div className="overflow-y-auto flex-1">
        {transfers.map((t) => {
          const progress = t.srcSize > 0 ? t.transferred / t.srcSize : 0;
          const unfinished = t.status !== "done" && t.status !== "cancelled";
          return (
            <div
              key={t.id}
              className="px-3 py-1.5 border-b border-dark-800 last:border-0 flex items-center gap-2 text-xs"
            >
              <KindIcon job={t} />

              <span className="text-white truncate flex-1">
                {baseName(t.dest.path)}
              </span>
              {t.status === "active" && t.srcSize > 0 && (
                <span className="text-dark-500 text-[10px] shrink-0">
                  {formatBytes(t.transferred)} / {formatBytes(t.srcSize)}
                </span>
              )}

              {t.status === "active" ? (
                <div className="flex items-center gap-2">
                  <div className="w-16 bg-dark-700 rounded-full h-1">
                    <div
                      className="bg-primary-500 h-1 rounded-full transition-all"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                  <span className="text-dark-400 w-8 text-right">
                    {Math.round(progress * 100)}%
                  </span>
                  {t.speed ? (
                    <span className="text-dark-500 w-20 text-right">
                      {formatSpeed(t.speed)}
                    </span>
                  ) : null}
                </div>
              ) : t.status === "done" ? (
                <span className="flex items-center gap-1 text-green-400">
                  <CheckIcon className="w-3.5 h-3.5 shrink-0" weight="bold" />
                  Done
                </span>
              ) : (
                <span
                  className={`truncate max-w-48 ${t.status === "failed" ? "text-red-400" : "text-dark-400"}`}
                  title={t.error ?? undefined}
                >
                  {statusLabel(t, now)}
                </span>
              )}

              {(t.status === "queued" ||
                t.status === "active" ||
                t.status === "waiting") && (
                <RowButton
                  label="Pause"
                  onClick={() => void pauseTransfer(t.id)}
                >
                  <PauseIcon className="w-3 h-3" weight="bold" />
                </RowButton>
              )}
              {t.status === "paused" && (
                <RowButton
                  label="Resume"
                  onClick={() => void resumeTransfer(t.id)}
                >
                  <PlayIcon className="w-3 h-3" weight="bold" />
                </RowButton>
              )}
              {t.status === "failed" && (
                <RowButton
                  label="Retry"
                  onClick={() => void retryTransfer(t.id)}
                >
                  <ArrowClockwiseIcon className="w-3 h-3" weight="bold" />
                </RowButton>
              )}
              {unfinished && (
                <RowButton
                  label="Cancel"
                  onClick={() => void cancelTransfer(t.id)}
                >
                  <XIcon className="w-3 h-3 text-red-400" weight="bold" />
                </RowButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
