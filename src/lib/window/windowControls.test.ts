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
    windowMock.onFocusChanged.mockImplementation(
      async (handler: (event: { payload: boolean }) => void) => {
        handler({ payload: false });
        return vi.fn();
      },
    );
    const seen: boolean[] = [];
    await windowControls.watchFocus((focused) => seen.push(focused));
    expect(seen).toEqual([false]);
  });
});
