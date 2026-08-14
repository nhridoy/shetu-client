import { describe, expect, it } from "vitest";
import { useDragPreviewStore } from "./dragPreviewStore";

describe("dragPreviewStore", () => {
  it("setPreview sets previewHosts and isDragging: true", () => {
    const hosts = [
      { id: "h1", name: "a", address: "", port: 22, tags: [], sortOrder: 0 },
      { id: "h2", name: "b", address: "", port: 22, tags: [], sortOrder: 1 },
    ] as any[];
    useDragPreviewStore.getState().setPreview(hosts);
    expect(useDragPreviewStore.getState().previewHosts).toEqual(hosts);
    expect(useDragPreviewStore.getState().isDragging).toBe(true);
  });

  it("clearPreview sets previewHosts: null and isDragging: false", () => {
    useDragPreviewStore.setState({ previewHosts: [{} as any], isDragging: true });
    useDragPreviewStore.getState().clearPreview();
    expect(useDragPreviewStore.getState().previewHosts).toBeNull();
    expect(useDragPreviewStore.getState().isDragging).toBe(false);
  });
});
