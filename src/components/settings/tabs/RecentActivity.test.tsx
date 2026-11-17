// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/api/securityEvents", () => ({ securityEventsApi: api }));

import type { SecurityEvent } from "@/lib/api/securityEvents";
import RecentActivity, { eventTitle } from "./RecentActivity";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = new Date(Date.now() - 60_000).toISOString();
const ev = (over: Partial<SecurityEvent>): SecurityEvent => ({
  id: 1,
  kind: "sign_in",
  detail: "",
  device_name: "",
  platform: "",
  ip: "203.0.113.7",
  count: 1,
  ip_count: 1,
  created_at: at,
  last_at: at,
  current_device: false,
  ...over,
});

const roots: Root[] = [];
beforeEach(() => api.list.mockReset());
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

async function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RecentActivity />));
}
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;

describe("eventTitle", () => {
  it("names every kind", () => {
    const cases: Array<[Partial<SecurityEvent>, string]> = [
      [{ kind: "sign_in", detail: "password" }, "Signed in"],
      [{ kind: "sign_in", detail: "google" }, "Signed in · Google"],
      [{ kind: "sign_in", detail: "github" }, "Signed in · GitHub"],
      [{ kind: "sign_in_new_device" }, "New device signed in"],
      [{ kind: "sign_in_failed" }, "Failed sign-ins"],
      [{ kind: "two_factor_failed" }, "Wrong two-factor code"],
      [{ kind: "password_changed" }, "Password changed"],
      [{ kind: "recovery_used" }, "Password reset with recovery code"],
      [{ kind: "two_factor_enabled" }, "Two-factor turned on"],
      [{ kind: "two_factor_disabled" }, "Two-factor turned off"],
      [{ kind: "backup_code_used" }, "Backup code used"],
      [
        { kind: "device_revoked", detail: "Office PC" },
        "Device signed out: Office PC",
      ],
      [
        { kind: "devices_revoked_others", detail: "3" },
        "Signed out 3 other devices",
      ],
      [{ kind: "deletion_scheduled" }, "Account deletion scheduled"],
      [{ kind: "deletion_cancelled" }, "Account deletion cancelled"],
      [{ kind: "something_new" }, "Account activity"],
    ];
    for (const [over, title] of cases) expect(eventTitle(ev(over))).toBe(title);
  });
});

describe("RecentActivity", () => {
  it("shows rows with device, IP, grouped counts and this device", async () => {
    api.list.mockResolvedValue({
      events: [
        ev({
          id: 3,
          kind: "sign_in",
          detail: "password",
          device_name: "Alice's MacBook",
          platform: "macos",
          current_device: true,
        }),
        ev({
          id: 2,
          kind: "sign_in_failed",
          count: 12,
          ip_count: 4,
          ip: "192.0.2.55",
        }),
        ev({ id: 1, kind: "two_factor_failed", count: 3, ip_count: 1 }),
      ],
      next: null,
    });
    await setup();
    expect(text()).toContain(
      "Something you don't recognise? Sign out that device in Devices and change your password.",
    );
    expect(text()).toContain("Alice's MacBook · macOS · 203.0.113.7");
    expect(text()).toContain("This device");
    expect(text()).toContain("192.0.2.55 (12× from 4 addresses)");
    expect(text()).toContain("203.0.113.7 (3×)");
    expect(button("Show more")).toBeUndefined();
  });

  it("Show more appends the next page", async () => {
    api.list
      .mockResolvedValueOnce({
        events: [ev({ id: 9, kind: "password_changed" })],
        next: 9,
      })
      .mockResolvedValueOnce({
        events: [ev({ id: 8, kind: "two_factor_enabled" })],
        next: null,
      });
    await setup();
    await act(async () => button("Show more")?.click());
    expect(api.list).toHaveBeenLastCalledWith(9);
    expect(text()).toContain("Password changed");
    expect(text()).toContain("Two-factor turned on");
    expect(button("Show more")).toBeUndefined();
  });

  it("says when there is nothing yet", async () => {
    api.list.mockResolvedValue({ events: [], next: null });
    await setup();
    expect(text()).toContain("No activity yet");
  });

  it("offers a retry when loading fails", async () => {
    api.list.mockRejectedValueOnce(new Error("down"));
    await setup();
    expect(text()).toContain("Couldn't load recent activity.");
    api.list.mockResolvedValue({
      events: [ev({ kind: "password_changed" })],
      next: null,
    });
    await act(async () => button("Retry")?.click());
    expect(text()).toContain("Password changed");
  });
});
