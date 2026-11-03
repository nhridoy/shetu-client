import { getCurrentWindow } from "@tauri-apps/api/window";

const mainWindow = () => getCurrentWindow();

export const windowControls = {
  minimize: () => mainWindow().minimize(),
  toggleMaximize: () => mainWindow().toggleMaximize(),
  close: () => mainWindow().close(),
  startDragging: () => mainWindow().startDragging(),
  async toggleFullscreen() {
    const current = mainWindow();
    await current.setFullscreen(!(await current.isFullscreen()));
  },
  async watchFullscreen(onChange: (fullscreen: boolean) => void) {
    const current = mainWindow();
    onChange(await current.isFullscreen());
    return current.onResized(() => {
      void current
        .isFullscreen()
        .then(onChange)
        .catch(() => {});
    });
  },
  watchFocus(onChange: (focused: boolean) => void) {
    return mainWindow().onFocusChanged(({ payload }) => onChange(payload));
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
