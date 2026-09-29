import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/auth/authStore", () => ({ useAuthStore: vi.fn() }));

import { shouldRedirectPublicRoute } from "./AuthGuard";

describe("offline public-route routing", () => {
  it("opens the enrolled vault from /login after offline restart", () => {
    expect(shouldRedirectPublicRoute("u1", null, false)).toBe(true);
  });

  it("permits explicit same-account reauthentication without wiping data", () => {
    expect(shouldRedirectPublicRoute("u1", { reauth: true }, false)).toBe(
      false,
    );
    expect(shouldRedirectPublicRoute("u1", { reauth: true }, true)).toBe(true);
  });
});
