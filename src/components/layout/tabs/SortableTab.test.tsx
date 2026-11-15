// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: () => ({ ref: () => {}, isDragging: false }),
}));

import type { TerminalTab } from "@/stores/terminal/terminalStore";
import SortableTab from "./SortableTab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (broadcast: boolean): TerminalTab => ({
  id: "t1",
  root: {
    type: "leaf",
    id: "p1",
    hostId: "",
    hostName: "",
    title: "",
    connectionStatus: "connected",
    reconnect: null,
    size: 100,
  } as never,
  activePaneId: "p1",
  focusedPaneId: null,
  isActive: true,
  title: "prod",
  activePresetId: null,
  activePresetName: null,
  savedPresetSnapshot: "",
  presetDirty: false,
  broadcast,
});

async function render(broadcast: boolean) {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <SortableTab
        tab={tab(broadcast)}
        index={0}
        isActive
        onActivate={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return () => act(() => root.unmount());
}

describe("SortableTab", () => {
  it("shows the broadcast icon only while the tab broadcasts", async () => {
    let unmount = await render(false);
    expect(document.querySelector('[title="Broadcasting input"]')).toBeNull();
    unmount();
    unmount = await render(true);
    expect(
      document.querySelector('[title="Broadcasting input"]'),
    ).not.toBeNull();
    unmount();
  });
});
