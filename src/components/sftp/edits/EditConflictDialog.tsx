import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { type EditChoice, resolveEdit } from "@/lib/sftp/edits";
import { useSftpStore } from "@/stores/sftp/sftpStore";

/** A save found the server copy changed since it was opened: the user decides. Closing it
 * leaves the conflict pending (the Editing list keeps a Resolve button). */
export default function EditConflictDialog() {
  const conflict = useSftpStore((s) => s.editConflict);
  const setEditConflict = useSftpStore((s) => s.setEditConflict);
  const choose = (choice: EditChoice) => {
    if (!conflict) return;
    resolveEdit(conflict.id, choice).catch((e) =>
      toast.error(e instanceof Error ? e.message : String(e)),
    );
    setEditConflict(null);
  };
  return (
    <Modal
      open={conflict !== null}
      onClose={() => setEditConflict(null)}
      title="Server copy changed"
      maxWidth="max-w-md"
    >
      <p className="text-sm text-dark-300 mb-4">
        {conflict?.fileName} changed on {conflict?.host} since you opened it.
      </p>
      <div className="flex flex-col gap-2">
        <Button onClick={() => choose("overwrite")}>Overwrite server</Button>
        <Button variant="ghost" onClick={() => choose("keepServer")}>
          Keep server's version
        </Button>
        <Button variant="ghost" onClick={() => choose("saveAsCopy")}>
          Save mine as a copy
        </Button>
      </div>
    </Modal>
  );
}
