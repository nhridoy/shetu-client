// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

import { useSettingsStore } from "@/stores/settings/settingsStore";
import AppLockSettings from "./AppLockSettings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
const update = vi.fn(async () => {});
beforeEach(() => {
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      lockAfterIdleMinutes: 0,
      lockOnSystemLock: true,
    },
    updateSetting: update as never,
  }));
  update.mockClear();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root?.render(<AppLockSettings />));
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const byText = (t: string) =>
  [
    ...document.querySelectorAll<HTMLElement>("button, [role=option], label"),
  ].find((el) => el.textContent?.trim() === t) as HTMLElement;

describe("AppLockSettings", () => {
  it("idle select and sleep toggle update settings", () => {
    expect(document.body.textContent).toContain("Lock after idle");
    act(() => (document.getElementById("lock-idle") as HTMLElement).click());
    // The house Select picks on mousedown.
    act(() => {
      byText("15 minutes").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(update).toHaveBeenCalledWith("lockAfterIdleMinutes", 15);
    act(() =>
      (document.getElementById("lock-on-system") as HTMLElement).click(),
    );
    expect(update).toHaveBeenCalledWith("lockOnSystemLock", false);
  });
});
