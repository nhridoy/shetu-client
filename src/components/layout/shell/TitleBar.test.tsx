import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/window/windowControls", () => ({
  windowControls: {
    watchMaximized: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    startDragging: vi.fn(),
  },
}));

import TitleBar from "./TitleBar";

describe("TitleBar", () => {
  it("renders labeled window controls and a separate drag area", () => {
    const html = renderToStaticMarkup(<TitleBar />);
    expect(html).toContain('aria-label="Minimize window"');
    expect(html).toContain('aria-label="Maximize window"');
    expect(html).toContain('aria-label="Close window"');
    expect(html).toContain("data-titlebar-drag-area");
  });
});
