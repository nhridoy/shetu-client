// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/react", () => ({
  useDraggable: () => ({ ref: () => {}, isDragging: false }),
  useDroppable: () => ({ ref: () => {}, isDropTarget: false }),
}));
vi.mock("@/components/terminal/shell/Terminal", () => ({
  default: () => null,
}));
vi.mock("@/components/terminal/browser/HostBrowser", () => ({
  default: () => null,
}));
vi.mock("@/components/portforwarding/panels/PortForwarding", () => ({
  default: () => null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  type LeafNode,
  useTerminalStore,
} from "@/stores/terminal/terminalStore";
import Pane from "./Pane";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const leaf = {
  type: "leaf",
  id: "p1",
  hostId: "h1",
  hostName: "web-1",
  title: "web-1",
  connectionStatus: "connected",
  reconnect: null,
  size: 100,
} as LeafNode;

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(broadcast: boolean) {
  useTerminalStore.setState({
    tabs: [{ id: "t1", root: leaf, activePaneId: "p1", broadcast } as never],
    activeTabId: "t1",
  });
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(
      <Pane
        tabId="t1"
        pane={leaf}
        isActive
        closable={false}
        isActiveTab
        onRestorePreset={() => {}}
      />,
    ),
  );
  return root;
}

describe("Pane broadcast indicator", () => {
  it("shows the badge and amber outline only while its tab broadcasts", async () => {
    let root = await render(false);
    const pane = () => document.querySelector("[data-pane-id=p1]");
    expect(document.body.textContent).not.toContain("Broadcasting");
    expect(pane()?.className).not.toContain("ring-amber-500");
    act(() => root.unmount());
    root = await render(true);
    expect(document.body.textContent).toContain("Broadcasting");
    expect(pane()?.className).toContain("ring-amber-500/70");
    act(() => root.unmount());
  });
});
