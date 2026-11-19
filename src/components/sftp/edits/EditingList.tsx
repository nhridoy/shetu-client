import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import {
  fileNameOf,
  openRemoteFile,
  type RemoteEdit,
  stopEdit,
  uploadEditNow,
} from "@/lib/sftp/edits";
import { useSftpStore } from "@/stores/sftp/sftpStore";

function statusLabel(edit: RemoteEdit): string {
  switch (edit.status) {
    case "uploading":
      return "Uploading…";
    case "conflict":
      return "Conflict: server copy changed";
    case "notUploaded":
      return "Not uploaded";
    default:
      return edit.error ?? "Watching";
  }
}

const report = (e: unknown) =>
  toast.error(e instanceof Error ? e.message : String(e));

/** Remote files open in a desktop app, with Stop and the actions their state allows. */
export default function EditingList() {
  const edits = useSftpStore((s) => s.edits);
  const setEditConflict = useSftpStore((s) => s.setEditConflict);
  const [stopping, setStopping] = useState<RemoteEdit | null>(null);

  const stop = (edit: RemoteEdit) => {
    if (edit.unsent) setStopping(edit);
    // A save not seen yet is still unsent: Rust checks the file and asks the same question.
    else
      stopEdit(edit.id, false).catch((e) =>
        e === "unsent" ? setStopping(edit) : report(e),
      );
  };

  if (edits.length === 0) return null;
  return (
    <div className="border-t border-dark-700 bg-dark-900 text-xs">
      <div className="px-3 py-1.5 border-b border-dark-700 text-dark-300">
        Editing remotely
      </div>
      {edits.map((edit) => (
        <div
          key={edit.id}
          className="px-3 py-1.5 border-b border-dark-800 last:border-0 flex items-center gap-2"
        >
          <span className="text-white truncate">
            {fileNameOf(edit.remotePath)}
          </span>
          <span className="text-dark-500 truncate flex-1">
            {edit.host.host}:{edit.remotePath}
          </span>
          <span
            className={
              edit.status === "conflict" || edit.error
                ? "text-yellow-400"
                : "text-dark-400"
            }
          >
            {statusLabel(edit)}
          </span>
          {edit.status === "conflict" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setEditConflict({
                  id: edit.id,
                  fileName: fileNameOf(edit.remotePath),
                  host: edit.host.host,
                  remotePath: edit.remotePath,
                })
              }
            >
              Resolve
            </Button>
          )}
          {edit.status === "notUploaded" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => uploadEditNow(edit.id).catch(report)}
            >
              Upload
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                openRemoteFile(edit.sessionId, edit.remotePath).catch(report)
              }
            >
              Open again
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => stop(edit)}>
            Stop
          </Button>
        </div>
      ))}
      <Modal
        open={stopping !== null}
        onClose={() => setStopping(null)}
        title="Changes not uploaded"
        maxWidth="max-w-md"
      >
        <p className="text-sm text-dark-300 mb-4">
          Your latest changes to{" "}
          {stopping ? fileNameOf(stopping.remotePath) : ""} haven't reached the
          server yet.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setStopping(null)}>
            Keep editing
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (stopping) stopEdit(stopping.id, true).catch(report);
              setStopping(null);
            }}
          >
            Discard
          </Button>
          <Button
            onClick={() => {
              if (stopping) uploadEditNow(stopping.id).catch(report);
              setStopping(null);
            }}
          >
            Upload now
          </Button>
        </div>
      </Modal>
    </div>
  );
}
