// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelAccountDeletion = vi.fn();
const logout = vi.fn();
const state = { pendingDeletion: null as string | null };

vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({
    pendingDeletion: state.pendingDeletion,
    cancelAccountDeletion,
    logout,
  }),
}));

import PendingDeletionDialog from "./PendingDeletionDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  cancelAccountDeletion.mockReset();
  logout.mockReset();
  state.pendingDeletion = "2026-12-13T00:00:00Z";
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<PendingDeletionDialog />));
  return () => act(() => root.render(<PendingDeletionDialog />));
}

const btn = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;
const click = async (el: HTMLElement) =>
  act(async () => {
    el.click();
  });

describe("PendingDeletionDialog", () => {
  it("grace_dialog_shows_date_and_keeps_account", async () => {
    cancelAccountDeletion.mockImplementation(async () => {
      state.pendingDeletion = null;
    });
    setup();
    const date = new Date(state.pendingDeletion as string).toLocaleDateString(
      undefined,
      { dateStyle: "long" },
    );
    expect(document.body.textContent).toContain(
      `Your account is scheduled for deletion on ${date}.`,
    );
    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
    await click(btn("Keep my account"));
    expect(cancelAccountDeletion).toHaveBeenCalledTimes(1);
  });

  it("grace_dialog_sign_out_logs_out", async () => {
    setup();
    await click(btn("Sign out"));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(cancelAccountDeletion).not.toHaveBeenCalled();
  });

  it("grace_dialog_shows_keep_error", async () => {
    cancelAccountDeletion.mockRejectedValue(
      new Error("Another account is enrolled"),
    );
    setup();
    await click(btn("Keep my account"));
    expect(document.body.textContent).toContain("Another account is enrolled");
    expect(btn("Sign out").disabled).toBe(false);
    expect(btn("Keep my account").disabled).toBe(false);
  });

  it("grace_dialog_drops_a_stale_error_on_the_next_sign_in", async () => {
    cancelAccountDeletion.mockRejectedValue(new Error("Keep failed"));
    const rerender = setup();
    await click(btn("Keep my account"));
    expect(document.body.textContent).toContain("Keep failed");
    state.pendingDeletion = null;
    rerender();
    state.pendingDeletion = "2026-12-20T00:00:00Z";
    rerender();
    expect(document.body.textContent).not.toContain("Keep failed");
  });

  it("renders_nothing_without_pending_deletion", () => {
    state.pendingDeletion = null;
    setup();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
