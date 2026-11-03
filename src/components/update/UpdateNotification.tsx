import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { type UpdateState, useUpdateStore } from "@/stores/update/updateStore";

export const UPDATE_TOAST_ID = "app-update";

// A button that keeps the toast open, so the next step replaces it in place.
const keepOpen = (label: string, run: () => Promise<void>) => ({
  label,
  onClick: (event: { preventDefault: () => void }) => {
    event.preventDefault();
    void run();
  },
});

// Drives one persistent, non-blocking toast through the update flow. Sonner
// merges updates into an existing toast, so every call sets each field.
export function syncUpdateToast(state: UpdateState) {
  const { status, error, promptDismissed, dismissUpdate } = state;
  const version = state.updateInfo?.version ?? "";
  const later = { label: "Later", onClick: dismissUpdate };
  const base = {
    id: UPDATE_TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    onDismiss: dismissUpdate,
    dismissible: true,
    action: undefined,
    cancel: undefined,
    description: undefined as ReactNode,
  };
  if (promptDismissed) {
    toast.dismiss(UPDATE_TOAST_ID);
    return;
  }
  switch (status) {
    case "available":
      toast(`Terra ${version} is available`, {
        ...base,
        description: error ?? "It downloads in the background while you work.",
        action: keepOpen(error ? "Retry" : "Download", state.downloadUpdate),
        cancel: later,
      });
      return;
    case "downloading":
      toast.loading(`Downloading Terra ${version}…`, {
        ...base,
        dismissible: false,
        description: <DownloadProgress value={state.downloadProgress} />,
      });
      return;
    case "ready":
      toast(`Terra ${version} is ready`, {
        ...base,
        description: error ?? "Restart to finish installing.",
        action: keepOpen("Restart & install", state.installUpdate),
        cancel: later,
      });
      return;
    case "installing":
      toast.loading("Installing update…", { ...base, dismissible: false });
      return;
    case "restart_required":
      toast("Update installed", {
        ...base,
        description: error ?? "Restart Terra to finish.",
        action: keepOpen("Restart now", state.restartApp),
        cancel: later,
      });
      return;
    default:
      toast.dismiss(UPDATE_TOAST_ID);
  }
}

function DownloadProgress({ value }: { value: number | null }) {
  return (
    <div className="mt-1.5 w-full">
      <div
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-dark-700"
      >
        <div
          className="h-full rounded-full bg-primary-500 transition-[width]"
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      <p className="mt-1 text-xs">
        {value === null ? "Starting…" : `${value}%`}
      </p>
    </div>
  );
}

export default function UpdateNotification() {
  const state = useUpdateStore();
  useEffect(() => syncUpdateToast(state), [state]);
  return null;
}
