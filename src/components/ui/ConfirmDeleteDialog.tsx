import ConfirmDialog from "@/components/ui/ConfirmDialog";

interface ConfirmDeleteDialogProps {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDeleteDialog({
  open,
  message,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Confirm Delete"
      message={message}
      confirmLabel="Delete"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
