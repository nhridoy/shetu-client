// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((e: { preventDefault: () => void }) => Promise<void>),
  unlisten: vi.fn(),
  destroy: vi.fn(async () => {}),
  onCloseRequested: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@/lib/common/utils", async (orig) => ({
  ...(await orig<object>()),
  isTauriAvailable: () => true,
}));

import UnsavedChangesDialog from "@/components/common/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import { useWindowCloseGuard } from "./useWindowCloseGuard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Guarded() {
  useWindowCloseGuard();
  return <UnsavedChangesDialog />;
}

let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  win.onCloseRequested.mockImplementation(async (h) => {
    win.handler = h;
    return win.unlisten;
  });
  const c = document.createElement("div");
  document.body.append(c);
  root = createRoot(c);
  await act(async () => root.render(<Guarded />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  useUnsavedChanges.getState().answer(false);
  useUnsavedChanges.getState().setDirty(false);
});

const byText = (t: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === t,
  ) as HTMLElement;
const requestClose = () => {
  const e = { preventDefault: vi.fn() };
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = win.handler?.(e) ?? done;
  });
  return { e, done };
};

describe("window close guard", () => {
  it("lets a clean window close", async () => {
    const { e } = requestClose();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Discard changes?");
  });

  it("asks when dirty; Keep editing keeps the window, Discard destroys it", async () => {
    useUnsavedChanges.getState().setDirty(true);
    let { e, done } = requestClose();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard changes?");
    await act(async () => {
      byText("Keep editing").click();
      await done;
    });
    expect(win.destroy).not.toHaveBeenCalled();

    ({ done } = requestClose());
    await act(async () => {
      byText("Discard").click();
      await done;
    });
    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it("stops listening on unmount", async () => {
    act(() => root.unmount());
    expect(win.unlisten).toHaveBeenCalled();
    root = createRoot(document.createElement("div"));
  });
});
