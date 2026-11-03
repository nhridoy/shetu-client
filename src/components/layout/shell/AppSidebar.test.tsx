import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/keys" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: () => ({
    user: { full_name: "Ada", email: "a@x.io" },
    logout: vi.fn(),
  }),
}));

import AppSidebar from "./AppSidebar";

describe("AppSidebar (mac source list)", () => {
  it("marks only the current section and offers a labeled Log Out", () => {
    const html = renderToStaticMarkup(
      <AppSidebar
        isOpen
        isMobile={false}
        onClose={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Keys/);
    expect(html).toContain('aria-label="Log Out"');
    expect(html).toContain("w-56");
  });
});
