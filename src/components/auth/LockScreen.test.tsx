// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ unlock: vi.fn(), logout: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));
vi.mock("@/stores/auth/authStore", async () => {
  const { create } = await import("zustand");
  const useAuthStore = create<{
    appLocked: boolean;
    unlock: (p: string) => Promise<void>;
    logout: () => Promise<void>;
  }>(() => ({ appLocked: false, unlock: h.unlock, logout: h.logout }));
  return { useAuthStore };
});

import { useShortcut } from "@/hooks/useShortcut";
import { useAuthStore } from "@/stores/auth/authStore";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import LockScreen from "./LockScreen";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
const settings = vi.fn();
function App() {
  useShortcut("app.settings", settings);
  return (
    <div>
      <p>web-1</p>
      <button type="button">Connect</button>
    </div>
  );
}

function render() {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <>
        <App />
        <LockScreen />
      </>,
    ),
  );
}
const lock = (on: boolean) =>
  act(() => useAuthStore.setState({ appLocked: on }));
const field = () =>
  document.querySelector(
    '[aria-label="Shetu is locked"] input',
  ) as HTMLInputElement;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement;
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ appLocked: false });
  useShortcutStore.setState({ overrides: {}, recording: false, locked: false });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("LockScreen", () => {
  it("covers_and_hides_content", () => {
    render();
    expect(document.querySelector('[aria-label="Shetu is locked"]')).toBeNull();
    lock(true);
    expect(
      document.querySelector('[aria-label="Shetu is locked"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(true);
    lock(false);
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(false);
  });

  it("wrong_password_stays_locked", async () => {
    h.unlock.mockRejectedValue(new Error("Wrong password"));
    render();
    lock(true);
    for (let i = 0; i < 2; i++) {
      type("nope");
      await act(async () => button("Unlock").click());
      expect(document.body.textContent).toContain("Wrong password");
      expect(useAuthStore.getState().appLocked).toBe(true);
    }
  });

  it("right_password_unlocks", async () => {
    h.unlock.mockImplementation(async () =>
      useAuthStore.setState({ appLocked: false }),
    );
    render();
    lock(true);
    type("pw");
    await act(async () => button("Unlock").click());
    expect(h.unlock).toHaveBeenCalledWith("pw");
    expect(document.querySelector('[aria-label="Shetu is locked"]')).toBeNull();
  });

  it("sign_out_calls_logout", async () => {
    render();
    lock(true);
    await act(async () => button("Sign out").click());
    expect(h.logout).toHaveBeenCalled();
  });

  it("shortcuts_and_terminal_input_blocked_while_locked", () => {
    render();
    lock(true);
    const outside = vi.fn();
    const terminal = document.querySelector("#root button") as HTMLElement;
    terminal.addEventListener("keydown", outside);
    act(() => {
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
      field().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ",",
          code: "Comma",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      field().dispatchEvent(
        new KeyboardEvent("keyup", {
          key: ",",
          code: "Comma",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(outside).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(useShortcutStore.getState().locked).toBe(true);
  });

  it("lock_screen_covers_open_dialogs", () => {
    render();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    lock(true);
    // Everything but the lock screen is inert, including dialogs portaled to <body>.
    expect(dialog.hasAttribute("inert")).toBe(true);
    const cover = document.querySelector(
      '[aria-label="Shetu is locked"]',
    ) as HTMLElement;
    expect(cover.closest("[inert]")).toBeNull();
  });
});
