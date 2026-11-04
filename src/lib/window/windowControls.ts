import { getCurrentWindow } from "@tauri-apps/api/window";

const mainWindow = () => getCurrentWindow();

let fullscreenQueue: Promise<void> = Promise.resolve();

export const windowControls = {
  minimize: () => mainWindow().minimize(),
  toggleMaximize: () => mainWindow().toggleMaximize(),
  close: () => mainWindow().close(),
  startDragging: () => mainWindow().startDragging(),
  toggleFullscreen() {
    // Chained so rapid clicks each read the state the previous one left.
    fullscreenQueue = fullscreenQueue
      .catch(() => {})
      .then(async () => {
        const current = mainWindow();
        await current.setFullscreen(!(await current.isFullscreen()));
      });
    return fullscreenQueue;
  },
  async watchFullscreen(onChange: (fullscreen: boolean) => void) {
    const current = mainWindow();
    // Listen first, then read, so a change in between is not missed.
    const unlisten = await current.onResized(() => {
      void current
        .isFullscreen()
        .then(onChange)
        .catch(() => {});
    });
    onChange(await current.isFullscreen());
    return unlisten;
  },
  async watchFocus(onChange: (focused: boolean) => void) {
    const current = mainWindow();
    const unlisten = await current.onFocusChanged(({ payload }) =>
      onChange(payload),
    );
    onChange(await current.isFocused());
    return unlisten;
  },
  async watchMaximized(onChange: (maximized: boolean) => void) {
    const current = mainWindow();
    onChange(await current.isMaximized());
    return current.onResized(() => {
      void current
        .isMaximized()
        .then(onChange)
        .catch(() => {});
    });
  },
};
