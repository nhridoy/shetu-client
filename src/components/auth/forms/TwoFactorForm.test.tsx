// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  pendingTwoFactor: { path: "login", challenge: "ch" } as {
    path: string;
    challenge: string;
  } | null,
  submitTwoFactor: vi.fn(async () => {}),
  sendTwoFactorEmail: vi.fn(async () => {}),
  cancelTwoFactor: vi.fn(),
};
vi.mock("@/stores/auth/authStore", () => ({ useAuthStore: () => store }));
vi.mock("@/components/auth/AuthLayout", () => ({
  default: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </div>
  ),
}));

import TwoFactorForm from "./TwoFactorForm";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  store.pendingTwoFactor = { path: "login", challenge: "ch" };
  vi.clearAllMocks();
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<TwoFactorForm />));
}

const field = () =>
  document.querySelector("input[name=two-factor-code]") as HTMLInputElement;
function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("TwoFactorForm", () => {
  it("submits an authenticator code", async () => {
    setup();
    expect(document.body.textContent).toContain("Two-factor code");
    expect(document.querySelector("label")?.textContent).toContain(
      "6-digit code",
    );
    type("123 456");
    await click("Continue");
    expect(store.submitTwoFactor).toHaveBeenCalledWith("123 456", "totp");
  });

  it("switches to a backup code", async () => {
    setup();
    await click("Use a backup code");
    type("abcd-efgh");
    await click("Continue");
    expect(store.submitTwoFactor).toHaveBeenCalledWith("abcd-efgh", "backup");
    await click("Use your authenticator");
    expect(button("Use a backup code")).toBeTruthy();
  });

  it("offers the email code only on recovery", async () => {
    setup();
    expect(button("Lost your authenticator? Email me a code")).toBeUndefined();
    for (const r of roots.splice(0)) act(() => r.unmount());
    store.pendingTwoFactor = { path: "recovery", challenge: "ch" };
    setup();
    await click("Lost your authenticator? Email me a code");
    expect(store.sendTwoFactorEmail).toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "We sent a code to your email.",
    );
    type("654321");
    await click("Continue");
    expect(store.submitTwoFactor).toHaveBeenCalledWith("654321", "email");
  });

  it("shows a wrong code and keeps the form", async () => {
    store.submitTwoFactor.mockRejectedValueOnce(
      new Error("That code isn't right."),
    );
    setup();
    type("000000");
    await click("Continue");
    expect(document.body.textContent).toContain("That code isn't right.");
    expect(field()).toBeTruthy();
  });

  it("cancel returns to the form", async () => {
    setup();
    await click("Cancel");
    expect(store.cancelTwoFactor).toHaveBeenCalled();
  });
});
