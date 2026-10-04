import { getCurrentWindow } from "@tauri-apps/api/window";

const mainWindow = () => getCurrentWindow();

export const windowControls = {
  minimize: () => mainWindow().minimize(),
  toggleMaximize: () => mainWindow().toggleMaximize(),
  close: () => mainWindow().close(),
  startDragging: () => mainWindow().startDragging(),
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
