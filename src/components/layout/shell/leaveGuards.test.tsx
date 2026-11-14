// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import UnsavedChangesDialog from "@/components/common/UnsavedChangesDialog";
import { VaultSelector } from "@/components/vault/selector/VaultSelector";
import { useSyncStore } from "@/stores/sync/syncStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import SyncStatus from "./SyncStatus";

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
function render(ui: ReactNode) {
  useUnsavedChanges.getState().setDirty(true);
  const c = document.createElement("div");
  document.body.append(c);
  root = createRoot(c);
  act(() =>
    root?.render(
      <>
        {ui}
        <UnsavedChangesDialog />
      </>,
    ),
  );
}

describe("leave guards outside the sidebar", () => {
  it("sync re-auth asks before going to login", async () => {
    useVaultStore.setState({ currentVaultId: "v1" });
    useSyncStore.setState({ state: "auth-required" });
    render(<SyncStatus />);
    await click(byText("Sign in to sync"));
    expect(document.body.textContent).toContain("Discard changes?");
    await click(byText("Keep editing"));
    expect(navigate).not.toHaveBeenCalled();
    await click(byText("Sign in to sync"));
    await click(byText("Discard"));
    expect(navigate).toHaveBeenCalledWith("/login", expect.anything());
  });

  it("switching vault asks first", async () => {
    const switchVault = vi.fn();
    useVaultStore.setState({
      vaults: [
        { id: "v1", name: "Personal" },
        { id: "v2", name: "Work" },
      ] as never,
      currentVaultId: "v1",
      switchVault,
    } as never);
    render(<VaultSelector />);
    await click(byText("Personal"));
    await click(byText("Work"));
    expect(document.body.textContent).toContain("Discard changes?");
    await click(byText("Keep editing"));
    expect(switchVault).not.toHaveBeenCalled();
    await click(byText("Personal"));
    await click(byText("Work"));
    await click(byText("Discard"));
    expect(switchVault).toHaveBeenCalledWith("v2");
  });
});
