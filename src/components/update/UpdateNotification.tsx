import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { useUpdateStore } from "@/stores/update/updateStore";

export default function UpdateNotification() {
  const status = useUpdateStore((state) => state.status);
  const installationKind = useUpdateStore((state) => state.installationKind);
  const updateInfo = useUpdateStore((state) => state.updateInfo);
  const progress = useUpdateStore((state) => state.downloadProgress);
  const error = useUpdateStore((state) => state.error);
  const promptDismissed = useUpdateStore((state) => state.promptDismissed);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const installUpdate = useUpdateStore((state) => state.installUpdate);
  const restartApp = useUpdateStore((state) => state.restartApp);
  const openReleasePage = useUpdateStore((state) => state.openReleasePage);
  const dismissUpdate = useUpdateStore((state) => state.dismissUpdate);
  const open =
    !promptDismissed &&
    [
      "available",
      "downloading",
      "ready",
      "installing",
      "restart_required",
    ].includes(status);
  const busy = status === "downloading" || status === "installing";

  return (
    <Modal open={open} onClose={() => !busy && dismissUpdate()}>
      <div className="p-6">
        <h2 className="mb-4 text-xl font-bold text-white">Update available</h2>
        <p className="mb-2 text-lg text-primary-400">
          Version {updateInfo?.version}
        </p>
        {updateInfo?.date && (
          <p className="mb-2 text-xs text-dark-400">
            Released {new Date(updateInfo.date).toLocaleDateString()}
          </p>
        )}
        {updateInfo?.notes && (
          <p className="mb-5 whitespace-pre-wrap text-sm text-dark-400">
            {updateInfo.notes}
          </p>
        )}
        {installationKind === "package" && (
          <p className="mb-5 text-sm text-dark-400">
            This Linux package is updated through your package installer. Open
            the release page to download the new version.
          </p>
        )}
        {status === "downloading" && (
          <div className="mb-5">
            <div className="h-2 w-full rounded-full bg-dark-700">
              <div
                className="h-2 rounded-full bg-primary-500 transition-all"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-center text-xs text-dark-400">
              {progress === null ? "Downloading…" : `${progress}%`}
            </p>
          </div>
        )}
        {status === "installing" && (
          <p className="mb-5 text-sm text-dark-400">Installing update…</p>
        )}
        {status === "restart_required" && (
          <p className="mb-5 text-sm text-dark-400">
            Update installed. Restart the app to finish.
          </p>
        )}
        {error && (
          <p role="alert" className="mb-5 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          {!busy && (
            <Button type="button" variant="ghost" onClick={dismissUpdate}>
              Later
            </Button>
          )}
          {installationKind === "package" && status === "available" && (
            <Button type="button" onClick={() => void openReleasePage()}>
              Open release page
            </Button>
          )}
          {installationKind !== "package" && status === "available" && (
            <Button type="button" onClick={() => void downloadUpdate()}>
              Download update
            </Button>
          )}
          {status === "ready" && (
            <Button
              type="button"
              variant="success"
              onClick={() => void installUpdate()}
            >
              Restart &amp; install
            </Button>
          )}
          {status === "restart_required" && (
            <Button
              type="button"
              variant="success"
              onClick={() => void restartApp()}
            >
              Restart now
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
