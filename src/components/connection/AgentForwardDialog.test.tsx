// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/db/db");
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));

import { useAgentForwardAsks } from "@/lib/terminal/agentForwarding";
import AgentForwardDialog from "./AgentForwardDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("shows the agent forwarding question and resolves Don't allow", async () => {
  const resolve = vi.fn();
  useAgentForwardAsks.setState({ queue: [{ host: "prod", resolve }] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<AgentForwardDialog />));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Forward your SSH agent to prod?");
  expect(text).toContain(
    "Lets this server use your local SSH keys while you're connected. Anyone with root on the server can use them too. Only enable for servers you trust.",
  );
  const dontAllow = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Don't allow",
  );
  act(() => dontAllow?.click());
  expect(resolve).toHaveBeenCalledWith(false);
  expect(useAgentForwardAsks.getState().queue).toHaveLength(0);
  expect(
    [...document.querySelectorAll("button")].map((b) => b.textContent),
  ).not.toContain("Allow");
  act(() => root.unmount());
});
