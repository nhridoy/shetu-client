import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";

export default function UnsavedChangesDialog() {
  const asking = useUnsavedChanges((s) => s.asking);
  const answer = useUnsavedChanges((s) => s.answer);
  return (
    <ConfirmDialog
      open={asking}
      title="Discard changes?"
      message="You have unsaved changes. They will be lost if you leave."
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );
}
