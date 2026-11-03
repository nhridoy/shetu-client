import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    loading: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/update/updateService", () => ({
  RELEASE_URL: "https://github.com/nhridoy/terra-client/releases/latest",
  updateService: {},
}));

import { type UpdateState, useUpdateStore } from "@/stores/update/updateStore";
import { syncUpdateToast, UPDATE_TOAST_ID } from "./UpdateNotification";

function state(overrides: Partial<UpdateState>): UpdateState {
  return {
    ...useUpdateStore.getState(),
    updateInfo: { version: "0.0.4", notes: "", date: null },
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    restartApp: vi.fn(async () => {}),
    dismissUpdate: vi.fn(),
    ...overrides,
  };
}

const click = (button: unknown) => {
  const event = { preventDefault: vi.fn() };
  (button as { onClick: (e: typeof event) => void }).onClick(event);
  return event;
};

beforeEach(() => vi.clearAllMocks());

describe("syncUpdateToast", () => {
  it("offers the download in a persistent toast that stays open", () => {
    const s = state({ status: "available" });
    syncUpdateToast(s);
    const [title, options] = toast.mock.calls[0];
    expect(title).toContain("0.0.4");
    expect(options).toMatchObject({
      id: UPDATE_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Download" },
      cancel: { label: "Later" },
    });
    expect(click(options.action).preventDefault).toHaveBeenCalled();
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows a progress bar without buttons and cannot be swiped away", () => {
    syncUpdateToast(state({ status: "downloading", downloadProgress: 40 }));
    const [, options] = toast.loading.mock.calls[0];
    expect(options).toMatchObject({
      id: UPDATE_TOAST_ID,
      dismissible: false,
      action: undefined,
      cancel: undefined,
    });
    const html = renderToStaticMarkup(options.description as ReactElement);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain("width:40%");
    expect(html).toContain("40%");
  });

  it("asks to restart once the update is downloaded", () => {
    const s = state({ status: "ready", downloadProgress: 100 });
    syncUpdateToast(s);
    const [, options] = toast.mock.calls[0];
    expect(options).toMatchObject({
      id: UPDATE_TOAST_ID,
      action: { label: "Restart & install" },
    });
    click(options.action);
    expect(s.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers a retry with the error after a failed download", () => {
    syncUpdateToast(state({ status: "available", error: "network down" }));
    const [, options] = toast.mock.calls[0];
    expect(options).toMatchObject({
      description: "network down",
      action: { label: "Retry" },
    });
  });

  it("removes the toast when dismissed or when no update is pending", () => {
    syncUpdateToast(state({ status: "available", promptDismissed: true }));
    syncUpdateToast(state({ status: "current" }));
    expect(toast.dismiss).toHaveBeenCalledTimes(2);
    expect(toast.dismiss).toHaveBeenCalledWith(UPDATE_TOAST_ID);
    expect(toast).not.toHaveBeenCalled();
  });
});
