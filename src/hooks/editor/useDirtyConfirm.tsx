import { useCallback, useState } from "react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

interface DirtyConfirmState {
  message: string;
  resolve: (ok: boolean) => void;
}

export function useDirtyConfirm() {
  const [state, setState] = useState<DirtyConfirmState | null>(null);

  const confirmIfDirty = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => setState({ message, resolve }));
  }, []);

  const dialog = state ? (
    <ConfirmDialog
      open
      title="Discard unsaved changes?"
      message={state.message}
      confirmLabel="Discard"
      destructive
      onConfirm={() => {
        state.resolve(true);
        setState(null);
      }}
      onCancel={() => {
        state.resolve(false);
        setState(null);
      }}
    />
  ) : null;

  return { confirmIfDirty, dialog };
}
