// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/hosts" }),
  useNavigate: () => navigate,
}));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({ user: { full_name: "Ada" }, logout: vi.fn() }),
}));

import UnsavedChangesDialog from "@/components/common/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import AppSidebar from "./AppSidebar";

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

function setup(dirty: boolean) {
  useUnsavedChanges.getState().setDirty(dirty);
  const c = document.createElement("div");
  document.body.append(c);
  root = createRoot(c);
  act(() =>
    root?.render(
      <>
        <AppSidebar
          isOpen
          isMobile={false}
          onClose={() => {}}
          onOpenSettings={() => {}}
        />
        <UnsavedChangesDialog />
      </>,
    ),
  );
}

describe("sidebar navigation guard", () => {
  it("navigates straight away when clean", async () => {
    setup(false);
    await click(byText("Keys"));
    expect(navigate).toHaveBeenCalledWith("/keys");
  });

  it("sidebar navigation asks when dirty", async () => {
    setup(true);
    await click(byText("Keys"));
    expect(document.body.textContent).toContain("Discard changes?");
    await click(byText("Keep editing"));
    expect(navigate).not.toHaveBeenCalled();
    await click(byText("Keys"));
    await click(byText("Discard"));
    expect(navigate).toHaveBeenCalledWith("/keys");
  });
});
