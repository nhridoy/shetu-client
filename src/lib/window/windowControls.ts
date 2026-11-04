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
    // Listen first, then read, so a change in between is not missed; a change
    // seen while the initial read is pending wins over that (stale) read.
    let changed = false;
    const unlisten = await current.onResized(() => {
      changed = true;
      void current
        .isFullscreen()
        .then(onChange)
        .catch(() => {});
    });
    const initial = await current.isFullscreen();
    if (!changed) onChange(initial);
    return unlisten;
  },
  async watchFocus(onChange: (focused: boolean) => void) {
    const current = mainWindow();
    let changed = false;
    const unlisten = await current.onFocusChanged(({ payload }) => {
      changed = true;
      onChange(payload);
    });
    const initial = await current.isFocused();
    if (!changed) onChange(initial);
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
