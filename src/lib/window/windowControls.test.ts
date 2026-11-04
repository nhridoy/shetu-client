import { beforeEach, describe, expect, it, vi } from "vitest";

const windowMock = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  onFocusChanged: vi.fn(),
  isFocused: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
}));

import { windowControls } from "./windowControls";

describe("window controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards actions to the main window", async () => {
    await windowControls.minimize();
    await windowControls.toggleMaximize();
    await windowControls.close();
    await windowControls.startDragging();
    expect(windowMock.minimize).toHaveBeenCalledOnce();
    expect(windowMock.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowMock.close).toHaveBeenCalledOnce();
    expect(windowMock.startDragging).toHaveBeenCalledOnce();
  });

  it("refreshes maximized state after a native resize", async () => {
    windowMock.isMaximized
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    windowMock.onResized.mockImplementation(async (handler: () => void) => {
      handler();
      return vi.fn();
    });
    const states: boolean[] = [];
    const unlisten = await windowControls.watchMaximized((state) =>
      states.push(state),
    );
    await vi.waitFor(() => expect(states).toEqual([false, true]));
    unlisten();
  });

  it("toggles fullscreen from the current state", async () => {
    windowMock.isFullscreen.mockResolvedValueOnce(false);
    await windowControls.toggleFullscreen();
    expect(windowMock.setFullscreen).toHaveBeenCalledWith(true);
  });

  it("reports focus changes", async () => {
    windowMock.isFocused.mockResolvedValueOnce(true);
    windowMock.onFocusChanged.mockImplementation(
      async (handler: (event: { payload: boolean }) => void) => {
        handler({ payload: false });
        return vi.fn();
      },
    );
    const seen: boolean[] = [];
    await windowControls.watchFocus((focused) => seen.push(focused));
    expect(seen).toEqual([false, true]);
  });

  it("serializes rapid fullscreen toggles so two clicks round-trip", async () => {
    let fullscreen = false;
    windowMock.isFullscreen.mockImplementation(async () => fullscreen);
    windowMock.setFullscreen.mockImplementation(async (next: boolean) => {
      await new Promise((r) => setTimeout(r, 5));
      fullscreen = next;
    });
    await Promise.all([
      windowControls.toggleFullscreen(),
      windowControls.toggleFullscreen(),
    ]);
    expect(windowMock.setFullscreen.mock.calls).toEqual([[true], [false]]);
    expect(fullscreen).toBe(false);
  });

  it("reports the current focus state on subscribe", async () => {
    windowMock.onFocusChanged.mockResolvedValue(vi.fn());
    windowMock.isFocused.mockResolvedValue(false);
    const seen: boolean[] = [];
    await windowControls.watchFocus((focused) => seen.push(focused));
    expect(seen).toEqual([false]);
  });

  it("subscribes to resizes before reading fullscreen state", async () => {
    const order: string[] = [];
    windowMock.onResized.mockImplementation(async () => {
      order.push("listen");
      return vi.fn();
    });
    windowMock.isFullscreen.mockImplementation(async () => {
      order.push("read");
      return false;
    });
    await windowControls.watchFullscreen(() => {});
    expect(order).toEqual(["listen", "read"]);
  });
});
