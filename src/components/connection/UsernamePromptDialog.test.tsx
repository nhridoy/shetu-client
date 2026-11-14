// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/db/db");
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));

import {
  askUsername,
  useUsernameAsks,
} from "@/lib/terminal/pendingCredentials";
import UsernamePromptDialog from "./UsernamePromptDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(async () => {
  useUsernameAsks.setState({ queue: [] });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<UsernamePromptDialog />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const btn = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;
const input = (type: string) =>
  document.querySelector(`input[type="${type}"]`) as HTMLInputElement;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

// Wrapped so awaiting the helper does not wait for the answer itself.
async function ask() {
  let answer!: ReturnType<typeof askUsername>;
  await act(async () => {
    answer = askUsername("prod");
  });
  return { answer };
}

describe("UsernamePromptDialog", () => {
  it("shows the title and Save checkbox, and answers with the typed name", async () => {
    const { answer } = await ask();
    expect(document.body.textContent).toContain("Username for prod");
    expect(document.body.textContent).toContain("Save to this host");
    await type(input("text"), " deploy ");
    await act(async () => input("checkbox").click());
    await act(async () => btn("Continue").click());
    await expect(answer).resolves.toEqual({ username: "deploy", save: true });
    expect(document.body.textContent).not.toContain("Username for prod");
  });

  it("Cancel answers null", async () => {
    const { answer } = await ask();
    await act(async () => btn("Cancel").click());
    await expect(answer).resolves.toBeNull();
  });

  it("an empty name does not submit", async () => {
    await ask();
    await act(async () => btn("Continue").click());
    expect(useUsernameAsks.getState().queue).toHaveLength(1);
  });
});
