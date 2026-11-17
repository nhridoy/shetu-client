// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  rename: vi.fn(),
  revoke: vi.fn(),
  revokeOthers: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api/devices", () => ({
  devicesApi: {
    list: h.list,
    rename: h.rename,
    revoke: h.revoke,
    revokeOthers: h.revokeOthers,
  },
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn() } }));

import DevicesSettings from "./DevicesSettings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const device = (id: string, over: Record<string, unknown> = {}) => ({
  device_id: id,
  name: `pc-${id}`,
  platform: "linux",
  app_version: "0.0.16",
  created_at: "2026-11-10T10:00:00Z",
  last_seen_at: "2026-11-17T10:00:00Z",
  current: false,
  ...over,
});

let root: Root | undefined;
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement;

async function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(<DevicesSettings />));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue([
    device("here", { current: true }),
    device("other"),
    device("blank", { name: "" }),
  ]);
  h.rename.mockResolvedValue(undefined);
  h.revoke.mockResolvedValue(undefined);
  h.revokeOthers.mockResolvedValue({ revoked: 2 });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("DevicesSettings", () => {
  it("lists devices with this one marked and no actions on it", async () => {
    await render();
    expect(text()).toContain("pc-here");
    expect(text()).toContain("This device");
    expect(text()).toContain("Unnamed device");
    expect(text()).toContain("Linux");
    expect(text()).toContain("Shetu 0.0.16");
    expect(button("Sign out pc-here")).toBeUndefined();
    expect(button("Sign out pc-other")).not.toBeUndefined();
  });

  it("rename saves the trimmed name and reloads", async () => {
    await render();
    await act(async () => button("Rename pc-other").click());
    const input = document.querySelector(
      'input[aria-label="Device name"]',
    ) as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "  Work PC  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(h.rename).toHaveBeenCalledWith("other", "Work PC");
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("sign out asks with the exact copy and revokes only on confirm", async () => {
    await render();
    await act(async () => button("Sign out pc-other").click());
    expect(text()).toContain(
      "Sign out pc-other? It loses access now and erases its Shetu data the next time it's online. If it was lost or stolen, also change your password.",
    );
    await act(async () => button("Cancel").click());
    expect(h.revoke).not.toHaveBeenCalled();
    await act(async () => button("Sign out pc-other").click());
    await act(async () => button("Sign out device").click());
    expect(h.revoke).toHaveBeenCalledWith("other");
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("sign out all other devices", async () => {
    await render();
    await act(async () => button("Sign out all other devices").click());
    await act(async () => button("Sign out all").click());
    expect(h.revokeOthers).toHaveBeenCalled();
    expect(h.success).toHaveBeenCalledWith("Signed out 2 devices");
  });

  it("a load error shows Retry, which reloads", async () => {
    h.list.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(text()).toContain("Couldn't load devices");
    await act(async () => button("Retry").click());
    expect(text()).toContain("pc-here");
  });

  it("only this device hides Sign out all", async () => {
    h.list.mockResolvedValue([device("here", { current: true })]);
    await render();
    expect(button("Sign out all other devices")).toBeUndefined();
  });
});
