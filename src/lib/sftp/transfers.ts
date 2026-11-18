import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirror of the Rust transfer manager's job (`src-tauri/src/transfers/model.rs`). */
export interface TransferHost {
  hostId: string | null;
  host: string;
  port: number;
  username: string;
}

export interface TransferEndpoint {
  path: string;
  host: TransferHost | null;
}

export type TransferKind = "download" | "upload" | "serverCopy";
export type TransferStatus =
  | "queued"
  | "active"
  | "paused"
  | "waiting"
  | "failed"
  | "done"
  | "cancelled";
export type TransferWaitReason = "retry" | "unlock" | "host";

export interface TransferJob {
  id: string;
  kind: TransferKind;
  src: TransferEndpoint;
  dest: TransferEndpoint;
  replace: boolean;
  partPath: string;
  srcSize: number;
  srcMtime: number;
  status: TransferStatus;
  transferred: number;
  attempt: number;
  nextRetryAt: number | null;
  waitReason: TransferWaitReason | null;
  error: string | null;
  createdAt: number;
  speed: number;
}

export interface NewJob {
  kind: TransferKind;
  srcPath: string;
  destPath: string;
  srcSessionId?: string;
  destSessionId?: string;
  replace: boolean;
}

export const TRANSFERS_CHANGED = "transfers://changed";
/** Sign-out / device wipe emptied the queue. */
export const TRANSFERS_RESET = "transfers://reset";

export const enqueueTransfers = (jobs: NewJob[]) =>
  invoke<TransferJob[]>("transfer_enqueue", { jobs });
export const listTransfers = () => invoke<TransferJob[]>("transfer_list");
export const pauseTransfer = (id: string) =>
  invoke<void>("transfer_pause", { id });
export const resumeTransfer = (id: string) =>
  invoke<void>("transfer_resume", { id });
export const resumeAllTransfers = () => invoke<void>("transfer_resume_all");
export const cancelTransfer = (id: string) =>
  invoke<void>("transfer_cancel", { id });
export const retryTransfer = (id: string) =>
  invoke<void>("transfer_retry", { id });
export const clearFinishedTransfers = () =>
  invoke<void>("transfer_clear_finished");
export const onTransfersChanged = (
  cb: (jobs: TransferJob[]) => void,
): Promise<UnlistenFn> =>
  listen<TransferJob[]>(TRANSFERS_CHANGED, (e) => cb(e.payload));

export const onTransfersReset = (cb: () => void): Promise<UnlistenFn> =>
  listen(TRANSFERS_RESET, () => cb());

/** Finished from the caller's point of view: nothing more will happen without the user. */
export function isSettled(job: TransferJob): boolean {
  if (["done", "failed", "cancelled", "paused"].includes(job.status))
    return true;
  return (
    job.status === "waiting" &&
    (job.waitReason === "host" || job.waitReason === "unlock")
  );
}
