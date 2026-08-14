import { create } from "zustand";
import type { Host } from "@/stores/hosts/hostStore";

interface DragPreviewState {
  previewHosts: Host[] | null;
  isDragging: boolean;
  setPreview: (hosts: Host[]) => void;
  clearPreview: () => void;
}

export const useDragPreviewStore = create<DragPreviewState>((set) => ({
  previewHosts: null,
  isDragging: false,
  setPreview: (hosts) => set({ previewHosts: hosts, isDragging: true }),
  clearPreview: () => set({ previewHosts: null, isDragging: false }),
}));
