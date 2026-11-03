import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { isLightTheme } from "./themeStore";

describe("isLightTheme", () => {
  it("tells light themes from dark ones by their background", () => {
    expect(isLightTheme("light")).toBe(true);
    expect(isLightTheme("solarized-light")).toBe(true);
    expect(isLightTheme("ayu-light")).toBe(true);
    expect(isLightTheme("dark")).toBe(false);
  });
});
