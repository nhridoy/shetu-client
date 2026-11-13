// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearDeletionNotice = vi.fn();
const state = {
  deletionNotice: null as
    | { kind: "scheduled"; date: string }
    | { kind: "deleted" }
    | null,
};

vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({
    login: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
    pendingVerificationEmail: null,
    deletionNotice: state.deletionNotice,
    clearDeletionNotice,
  }),
}));
vi.mock("@/components/auth/AuthLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/auth/forms/OAuthLogin", () => ({ default: () => null }));
vi.mock("@/components/auth/forms/ServerConfig", () => ({
  default: () => null,
}));
vi.mock("@/components/auth/forms/EmailVerification", () => ({
  default: () => null,
}));

import LoginPage from "./LoginPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  state.deletionNotice = null;
  clearDeletionNotice.mockReset();
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
  act(() =>
    root.render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    ),
  );
}

describe("LoginPage deletion notice", () => {
  it("sign_in_shows_scheduled_notice", () => {
    const iso = "2026-12-13T12:00:00Z";
    state.deletionNotice = { kind: "scheduled", date: iso };
    setup();
    const date = new Date(iso).toLocaleDateString(undefined, {
      dateStyle: "long",
    });
    expect(document.body.textContent).toContain(
      `Your account will be deleted on ${date}. Sign in to cancel.`,
    );
  });

  it("scheduled_notice_without_date", () => {
    state.deletionNotice = { kind: "scheduled", date: "" };
    setup();
    expect(document.body.textContent).toContain(
      "Your account is scheduled for deletion. Sign in to cancel.",
    );
    expect(document.body.textContent).not.toContain("Invalid Date");
  });

  it("sign_in_shows_deleted_notice", () => {
    state.deletionNotice = { kind: "deleted" };
    setup();
    expect(document.body.textContent).toContain(
      "This account has been deleted.",
    );
  });

  it("notice_can_be_dismissed", () => {
    state.deletionNotice = { kind: "deleted" };
    setup();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')
        ?.click(),
    );
    expect(clearDeletionNotice).toHaveBeenCalledTimes(1);
  });
});
