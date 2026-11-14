// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: [] as ((event: { payload: unknown }) => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import HostKeyDialog from "./HostKeyDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  mocks.handlers.length = 0;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockImplementation(async (_name, handler) => {
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
  await act(async () => root.render(<HostKeyDialog />));
}

const prompt = (payload: Record<string, unknown>) =>
  act(async () => {
    for (const h of mocks.handlers) h({ payload });
  });
const btn = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;
const click = (text: string) => act(async () => btn(text).click());

const newHost = {
  kind: "new",
  host: "web.example",
  port: 22,
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:newfp",
};

describe("HostKeyDialog", () => {
  it("listens once for the app-wide prompt event", async () => {
    await setup();
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0][0]).toBe("ssh-host-key-prompt");
  });

  it("asks before trusting a new host and sends the choice", async () => {
    await setup();
    await prompt(newHost);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Verify host key");
    expect(text).toContain(
      "First connection to web.example:22. Check that this fingerprint matches the server before trusting it.",
    );
    expect(text).toContain("ssh-ed25519");
    expect(text).toContain("SHA256:newfp");
    await click("Trust and connect");
    expect(mocks.invoke).toHaveBeenCalledWith("accept_host_key", {
      host: "web.example",
      port: 22,
      fingerprint: "SHA256:newfp",
      accepted: true,
    });
    expect(document.body.textContent).not.toContain("Verify host key");
  });

  it("warns about a changed key and cancels on Cancel", async () => {
    await setup();
    await prompt({
      kind: "changed",
      host: "db.example",
      port: 2222,
      keyType: "ssh-rsa",
      fingerprint: "SHA256:new",
      oldFingerprint: "SHA256:old",
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Host key changed");
    expect(text).toContain(
      "This could mean someone is intercepting the connection.",
    );
    expect(text).toContain("SHA256:old");
    expect(text).toContain("SHA256:new");
    expect(btn("Trust new key")).toBeTruthy();
    await click("Cancel");
    expect(mocks.invoke).toHaveBeenCalledWith("accept_host_key", {
      host: "db.example",
      port: 2222,
      fingerprint: "SHA256:new",
      accepted: false,
    });
  });

  it("is not dismissed by Escape", async () => {
    await setup();
    await prompt(newHost);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.textContent).toContain("Verify host key");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("shows queued prompts one at a time", async () => {
    await setup();
    await prompt(newHost);
    await prompt({ ...newHost, host: "second.example" });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("web.example:22");
    expect(document.body.textContent).not.toContain("second.example");
    await click("Cancel");
    expect(document.body.textContent).toContain("second.example:22");
    await click("Trust and connect");
    expect(mocks.invoke).toHaveBeenLastCalledWith("accept_host_key", {
      host: "second.example",
      port: 22,
      fingerprint: "SHA256:newfp",
      accepted: true,
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});
