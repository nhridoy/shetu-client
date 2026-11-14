import { create } from "zustand";

interface UnsavedChangesState {
  dirty: boolean;
  setDirty: (v: boolean) => void;
  /** Resolves true at once when clean; otherwise opens the discard confirm. */
  confirmLeave: () => Promise<boolean>;
  asking: boolean;
  answer: (discard: boolean) => void;
}

let pending: ((v: boolean) => void) | null = null;

export const useUnsavedChanges = create<UnsavedChangesState>((set, get) => ({
  dirty: false,
  asking: false,
  setDirty: (dirty) => set({ dirty }),
  confirmLeave: () => {
    if (!get().dirty) return Promise.resolve(true);
    pending?.(false);
    set({ asking: true });
    return new Promise<boolean>((resolve) => {
      pending = resolve;
    });
  },
  answer: (discard) => {
    const resolve = pending;
    pending = null;
    set({ asking: false });
    resolve?.(discard);
  },
}));
