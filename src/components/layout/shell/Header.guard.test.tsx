// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("@/components/layout/shell/SyncStatus", () => ({
  default: () => null,
}));
vi.mock("@/components/vault/selector/VaultSelector", () => ({
  default: () => null,
}));
vi.mock("@/components/layout/tabs/SortableTab", () => ({
  default: ({ onActivate }: { onActivate: () => void }) => (
    <button type="button" onClick={onActivate}>
      tab-one
    </button>
  ),
}));

import UnsavedChangesDialog from "@/components/common/UnsavedChangesDialog";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import Header from "./Header";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  useUnsavedChanges.getState().answer(false);
  useUnsavedChanges.getState().setDirty(false);
  navigate.mockClear();
});

const byText = (t: string) =>
  Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(t),
  ) as HTMLElement;
const click = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

function setup() {
  useTerminalStore.setState({
    tabs: [{ id: "t1", title: "one" }] as never,
  });
  useUnsavedChanges.getState().setDirty(true);
  const c = document.createElement("div");
  document.body.append(c);
  root = createRoot(c);
  act(() =>
    root?.render(
      <>
        <Header
          activeView="vault"
          setActiveView={() => {}}
          sidebarOpen
          setSidebarOpen={() => {}}
          onOpenSettings={() => {}}
          onSaveWorkspace={() => {}}
          onSavePreset={() => {}}
          onSavePresetChanges={() => {}}
        />
        <UnsavedChangesDialog />
      </>,
    ),
  );
}

describe("Header navigation guard", () => {
  it("terminal tab click asks when dirty", async () => {
    setup();
    await click(byText("tab-one"));
    expect(document.body.textContent).toContain("Discard changes?");
    await click(byText("Keep editing"));
    expect(navigate).not.toHaveBeenCalled();
    await click(byText("tab-one"));
    await click(byText("Discard"));
    expect(navigate).toHaveBeenCalledWith("/terminal");
  });

  it("new tab and view toggle ask when dirty", async () => {
    setup();
    await click(
      document.querySelector('[aria-label="New tab"]') as HTMLElement,
    );
    expect(document.body.textContent).toContain("Discard changes?");
    await click(byText("Keep editing"));
    expect(navigate).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs).toHaveLength(1);
  });
});
