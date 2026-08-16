import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import type { FileItem } from "@/types/sftp/sftpTypes";

const transferStartTimes = new Map<string | number, number>();

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="mt-1.5 w-full rounded-full h-1.5 overflow-hidden"
      style={{ backgroundColor: "var(--color-dark-700)" }}
    >
      <div
        className="h-1.5 rounded-full transition-all duration-200"
        style={{
          width: `${Math.min(percent, 100)}%`,
          backgroundColor: "var(--color-primary-500)",
        }}
      />
    </div>
  );
}

function TransferToast({
  label,
  fileNames,
  loaded,
  total,
  isSingle,
  startedAt,
  onCancel,
}: {
  label: string;
  fileNames: string[];
  loaded: number;
  total: number;
  isSingle: boolean;
  startedAt: number;
  onCancel?: () => void;
}) {
  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
  const elapsed = (Date.now() - startedAt) / 1000;
  const speed = elapsed > 0 ? loaded / elapsed : 0;

  return (
    <div className="text-sm w-full overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div
          className="font-medium min-w-0"
          style={{
            color: "var(--color-primary-500)",
            overflowWrap: "anywhere",
          }}
        >
          {isSingle ? fileNames[0] : `${fileNames.length} files`}
        </div>
        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      <div
        className="text-xs mt-0.5"
        style={{ color: "var(--color-primary-300)" }}
      >
        {label} {formatBytes(loaded)} / {formatBytes(total)} ({percent}%)
        {speed > 0 && ` · ${formatSpeed(speed)}`}
      </div>
      <ProgressBar percent={percent} />
    </div>
  );
}

export function showTransferStart(
  files: FileItem[],
  mode: "move" | "copy",
  onCancel?: () => void,
): string | number {
  const count = files.length;
  const verb = mode === "move" ? "Moving" : "Copying";
  const name = count === 1 ? files[0].name : `${count} files`;
  const startTime = Date.now();
  const toastId = toast.loading(
    <TransferToast
      label={`${verb} ${count === 1 ? "" : `${count} `}`}
      fileNames={files.map((f) => f.name)}
      loaded={0}
      total={files.reduce((s, f) => s + f.size, 0) || 1}
      isSingle={count === 1}
      startedAt={startTime}
      onCancel={onCancel}
    />,
    { description: name },
  );
  transferStartTimes.set(toastId, startTime);
  return toastId;
}

export function showTransferProgress(
  toastId: string | number,
  files: FileItem[],
  loaded: number,
  total: number,
  mode: "move" | "copy",
  onCancel?: () => void,
): void {
  const count = files.length;
  const verb = mode === "move" ? "Moving" : "Copying";
  const startedAt = transferStartTimes.get(toastId) ?? Date.now();
  toast.loading(
    <TransferToast
      label={`${verb} ${count === 1 ? "" : `${count} `}`}
      fileNames={files.map((f) => f.name)}
      loaded={loaded}
      total={total}
      isSingle={count === 1}
      startedAt={startedAt}
      onCancel={onCancel}
    />,
    { id: toastId },
  );
}

export function showTransferCancelled(
  toastId: string | number,
  files: FileItem[],
  mode: "move" | "copy",
): void {
  transferStartTimes.delete(toastId);
  const count = files.length;
  const verb = mode === "move" ? "Moved" : "Copied";
  const name = count === 1 ? files[0].name : `${count} files`;
  toast.warning(`${verb} cancelled: ${name}`, { id: toastId });
}

export function showTransferSuccess(
  toastId: string | number,
  files: FileItem[],
  mode: "move" | "copy",
): void {
  transferStartTimes.delete(toastId);
  const count = files.length;
  const verb = mode === "move" ? "Moved" : "Copied";
  const name = count === 1 ? files[0].name : `${count} files`;
  toast.success(`${verb} ${name}`, { id: toastId });
}

export function showTransferError(
  toastId: string | number,
  files: FileItem[],
  mode: "move" | "copy",
  error: string,
): void {
  transferStartTimes.delete(toastId);
  const count = files.length;
  const verb = mode === "move" ? "Move" : "Copy";
  toast.error(
    `Failed to ${verb} ${count === 1 ? files[0].name : `${count} files`}: ${error}`,
    {
      id: toastId,
    },
  );
}
