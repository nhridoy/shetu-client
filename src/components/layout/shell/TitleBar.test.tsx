import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/window/windowControls", () => ({
  windowControls: {
    watchMaximized: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    startDragging: vi.fn(),
    toggleFullscreen: vi.fn(),
    watchFullscreen: vi.fn(),
    watchFocus: vi.fn(),
  },
}));

import TitleBar, { WindowControls } from "./TitleBar";

describe("TitleBar", () => {
  it("renders labeled window controls and a separate drag area", () => {
    const html = renderToStaticMarkup(<TitleBar />);
    expect(html).toContain('aria-label="Minimize window"');
    expect(html).toContain('aria-label="Maximize window"');
    expect(html).toContain('aria-label="Close window"');
    expect(html).toContain("data-titlebar-drag-area");
  });

  it("draws labeled traffic lights on macOS in close, minimize, zoom order", () => {
    const html = renderToStaticMarkup(<WindowControls mac />);
    expect(html).toContain("data-traffic-lights");
    const order = ["Close window", "Minimize window", "Enter full screen"].map(
      (label) => html.indexOf(`aria-label="${label}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("#FF5F57");
  });

  it("keeps the existing buttons elsewhere", () => {
    const html = renderToStaticMarkup(<WindowControls mac={false} />);
    expect(html).not.toContain("data-traffic-lights");
    expect(html).toContain('aria-label="Maximize window"');
  });
});
