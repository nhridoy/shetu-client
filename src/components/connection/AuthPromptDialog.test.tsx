// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: [] as ((event: { payload: unknown }) => void)[],
  names: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import AuthPromptDialog from "./AuthPromptDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  mocks.handlers.length = 0;
  mocks.names.length = 0;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockImplementation(async (name, handler) => {
    mocks.names.push(name);
    mocks.handlers.push(handler);
    return () => {};
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

async function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AuthPromptDialog />));
}

const emit = (name: string, payload: Record<string, unknown>) =>
  act(async () => {
    mocks.handlers.forEach((h, i) => {
      if (mocks.names[i] === name) h({ payload });
    });
  });
const prompt = (payload: Record<string, unknown>) =>
  emit("ssh-auth-prompt", payload);
const btn = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;
const click = (text: string) => act(async () => btn(text).click());
const inputs = () =>
  Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const base = {
  id: "p1",
  host: "web.example",
  port: 22,
  username: "root",
  name: "Duo",
  instructions: "Approve the push",
  prompts: [
    { text: "Password: ", echo: false },
    { text: "Code: ", echo: true },
  ],
};

describe("AuthPromptDialog", () => {
  it("renders name, instructions and one input per prompt", async () => {
    await setup();
    expect(document.body.textContent).not.toContain("Login required");
    await prompt(base);
    expect(document.body.textContent).toContain(
      "Login required — root@web.example:22",
    );
    expect(document.body.textContent).toContain("Duo");
    expect(document.body.textContent).toContain("Approve the push");
    expect(inputs()).toHaveLength(2);
  });

  it("masks inputs when echo is false", async () => {
    await setup();
    await prompt(base);
    expect(inputs().map((i) => i.type)).toEqual(["password", "text"]);
  });

  it("Continue answers with the typed values", async () => {
    await setup();
    await prompt(base);
    await type(inputs()[0], "pw");
    await type(inputs()[1], "123456");
    await click("Continue");
    expect(mocks.invoke).toHaveBeenCalledWith("answer_auth_prompt", {
      id: "p1",
      responses: ["pw", "123456"],
    });
    expect(document.body.textContent).not.toContain("Login required");
  });

  it("Cancel answers with null", async () => {
    await setup();
    await prompt(base);
    await click("Cancel");
    expect(mocks.invoke).toHaveBeenCalledWith("answer_auth_prompt", {
      id: "p1",
      responses: null,
    });
  });

  it("queues a second prompt until the first is answered", async () => {
    await setup();
    await prompt(base);
    await prompt({
      ...base,
      id: "p2",
      name: "Second",
      prompts: [{ text: "Token: ", echo: false }],
    });
    expect(document.body.textContent).toContain("Duo");
    expect(document.body.textContent).not.toContain("Second");
    await click("Continue");
    expect(document.body.textContent).toContain("Second");
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].value).toBe("");
  });

  it("Escape cancels", async () => {
    await setup();
    await prompt(base);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(mocks.invoke).toHaveBeenCalledWith("answer_auth_prompt", {
      id: "p1",
      responses: null,
    });
  });

  it("closes the shown prompt when Rust ends it, without answering", async () => {
    await setup();
    await prompt(base);
    await emit("ssh-auth-prompt-closed", { id: "p1" });
    expect(document.body.textContent).not.toContain("Login required");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("never shows answers typed for a prompt Rust ended in the next one", async () => {
    await setup();
    await prompt(base);
    await prompt({
      ...base,
      id: "p2",
      name: "Second",
      prompts: [{ text: "Token: ", echo: true }],
    });
    await type(inputs()[0], "secret");
    const proto = HTMLInputElement.prototype;
    const value = Object.getOwnPropertyDescriptor(proto, "value");
    const shown: string[] = [];
    Object.defineProperty(proto, "value", {
      ...value,
      set(v: string) {
        shown.push(v);
        value?.set?.call(this, v);
      },
    });
    try {
      await emit("ssh-auth-prompt-closed", { id: "p1" });
    } finally {
      if (value) Object.defineProperty(proto, "value", value);
    }
    expect(document.body.textContent).toContain("Second");
    expect(shown).not.toContain("secret");
    expect(inputs()[0].value).toBe("");
  });

  it("drops a queued prompt that Rust ended", async () => {
    await setup();
    await prompt(base);
    await prompt({ ...base, id: "p2", name: "Second" });
    await emit("ssh-auth-prompt-closed", { id: "p2" });
    await click("Continue");
    expect(document.body.textContent).not.toContain("Login required");
  });
});
