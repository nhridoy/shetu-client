// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  startSetup: vi.fn(),
  confirm: vi.fn(),
  disable: vi.fn(),
  regenerateBackupCodes: vi.fn(),
}));
vi.mock("@/lib/api/twoFactor", () => ({ twoFactorApi: api }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import TwoFactorSettings from "./TwoFactorSettings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const off = {
  enabled: false,
  available: true,
  backup_codes_left: 0,
  email_verified: true,
};
const on = { ...off, enabled: true, backup_codes_left: 7 };
const codes = Array.from({ length: 10 }, (_, i) => `code-00${i}`);

const roots: Root[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

async function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<TwoFactorSettings />));
}
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;
async function click(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  await act(async () => b.click());
}
function type(label: string, value: string) {
  const input = document.getElementById(
    [...document.querySelectorAll("label")].find((l) =>
      l.textContent?.includes(label),
    )?.htmlFor ?? "",
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TwoFactorSettings", () => {
  it("says when the server can't do two-factor", async () => {
    api.status.mockResolvedValue({ ...off, available: false });
    await setup();
    expect(text()).toContain("Two-factor isn't available on this server.");
    expect(button("Turn on")).toBeUndefined();
  });

  it("setup shows the QR code and the secret", async () => {
    api.status.mockResolvedValue(off);
    api.startSetup.mockResolvedValue({
      otpauth_url: "otpauth://totp/Shetu:a",
      secret: "JBSWY3DP",
      email_code_sent: false,
    });
    await setup();
    await click("Turn on");
    const img = document.querySelector(
      "img[alt='Two-factor QR code']",
    ) as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,QR");
    expect(text()).toContain("JBSWY3DP");
    expect(text()).not.toContain("Code from your email");
  });

  it("asks for the email code when the server sent one", async () => {
    api.status.mockResolvedValue({ ...off, email_verified: false });
    api.startSetup.mockResolvedValue({
      otpauth_url: "otpauth://totp/Shetu:a",
      secret: "S",
      email_code_sent: true,
    });
    api.confirm.mockResolvedValue({ backup_codes: codes });
    await setup();
    await click("Turn on");
    type("6-digit code", "123456");
    type("Code from your email", "654321");
    await click("Confirm");
    expect(api.confirm).toHaveBeenCalledWith("123456", "654321");
  });

  it("Done stays off until the backup codes are saved", async () => {
    api.status.mockResolvedValue(off);
    api.startSetup.mockResolvedValue({
      otpauth_url: "otpauth://totp/Shetu:a",
      secret: "S",
      email_code_sent: false,
    });
    api.confirm.mockResolvedValue({ backup_codes: codes });
    await setup();
    await click("Turn on");
    type("6-digit code", "123456");
    await click("Confirm");
    expect(api.confirm).toHaveBeenCalledWith("123456", undefined);
    expect(text()).toContain("code-009");
    expect(button("Done")?.disabled).toBe(true);
    const tick = document.querySelector("[role=checkbox]") as HTMLButtonElement;
    await act(async () => tick.click());
    expect(button("Done")?.disabled).toBe(false);
    api.status.mockResolvedValue(on);
    await click("Done");
    expect(text()).toContain("7 backup codes left");
  });

  it("turning off asks for a code", async () => {
    api.status.mockResolvedValue(on);
    api.disable.mockResolvedValue(undefined);
    await setup();
    await click("Turn off");
    type("Code from your authenticator or a backup code", "abcd-efgh");
    api.status.mockResolvedValue(off);
    await click("Confirm");
    expect(api.disable).toHaveBeenCalledWith("abcd-efgh");
    expect(button("Turn on")).toBeTruthy();
  });

  it("new backup codes are shown once", async () => {
    api.status.mockResolvedValue(on);
    api.regenerateBackupCodes.mockResolvedValue({ backup_codes: codes });
    await setup();
    await click("New backup codes");
    type("Code from your authenticator or a backup code", "123456");
    await click("Confirm");
    expect(api.regenerateBackupCodes).toHaveBeenCalledWith("123456");
    expect(text()).toContain("code-000");
  });

  it("shows a wrong code without leaving the form", async () => {
    api.status.mockResolvedValue(on);
    api.disable.mockRejectedValue(new Error("That code isn't right."));
    await setup();
    await click("Turn off");
    type("Code from your authenticator or a backup code", "000000");
    await click("Confirm");
    expect(text()).toContain("That code isn't right.");
    expect(button("Confirm")).toBeTruthy();
  });

  it("an older status answer never overwrites a newer one", async () => {
    let slow!: (v: unknown) => void;
    api.status.mockResolvedValueOnce(on);
    api.regenerateBackupCodes.mockResolvedValue({ backup_codes: codes });
    await setup();
    await click("New backup codes");
    type("Code from your authenticator or a backup code", "123456");
    await click("Confirm");
    await act(async () => {
      (document.querySelector("[role=checkbox]") as HTMLButtonElement).click();
    });
    // Done's refresh stays pending while two-factor is turned off.
    api.status.mockReturnValueOnce(
      new Promise((r) => {
        slow = r;
      }),
    );
    await click("Done");
    api.disable.mockResolvedValue(undefined);
    api.status.mockResolvedValueOnce(off);
    await click("Turn off");
    type("Code from your authenticator or a backup code", "abcd-efgh");
    await click("Confirm");
    expect(button("Turn on")).toBeTruthy();
    await act(async () => slow(on));
    expect(button("Turn on")).toBeTruthy();
  });
});
