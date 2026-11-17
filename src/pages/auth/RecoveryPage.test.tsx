// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = {
  pendingTwoFactor: null as { path: string; challenge: string } | null,
};
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({
    recovery: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
    pendingTwoFactor: state.pendingTwoFactor,
  }),
}));
vi.mock("@/components/auth/AuthLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/auth/forms/TwoFactorForm", () => ({
  default: () => <div>two-factor form</div>,
}));

import RecoveryPage from "./RecoveryPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
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
        <RecoveryPage />
      </MemoryRouter>,
    ),
  );
}

describe("RecoveryPage", () => {
  it("shows the code form while recovery waits for it", () => {
    state.pendingTwoFactor = { path: "recovery", challenge: "ch" };
    setup();
    expect(document.body.textContent).toContain("two-factor form");
  });

  it("ignores a sign-in challenge", () => {
    state.pendingTwoFactor = { path: "login", challenge: "ch" };
    setup();
    expect(document.body.textContent).not.toContain("two-factor form");
  });
});
