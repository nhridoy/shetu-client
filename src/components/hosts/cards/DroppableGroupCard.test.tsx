// @vitest-environment happy-dom
import { DragDropProvider } from "@dnd-kit/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Group } from "@/stores/hosts/hostStore";
import { DroppableGroupCard } from "./DroppableGroupCard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DroppableGroupCard delete", () => {
  it("does not open the group it just deleted", () => {
    const openGroup = vi.fn();
    const deleteGroup = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <DragDropProvider>
          <DroppableGroupCard
            group={{ id: "g1", name: "Servers" } as Group}
            hostCount={0}
            childCount={0}
            onClick={openGroup}
            onEdit={() => {}}
            onDelete={deleteGroup}
          />
        </DragDropProvider>,
      ),
    );
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        (b) => b.title === label || b.textContent === label,
      );
    act(() => button("Delete group")?.click());
    // Keyboard and mouse confirmation must both stay inside the dialog.
    act(() => {
      button("Delete")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    act(() => button("Delete")?.click());
    expect(deleteGroup).toHaveBeenCalledWith("g1");
    expect(openGroup).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
