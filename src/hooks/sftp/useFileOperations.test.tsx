// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  resolveUsernameOrAsk: vi.fn(async () => "typed"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/terminal/agentForwarding", () => ({
  resolveUsernameOrAsk: mocks.resolveUsernameOrAsk,
}));

import { useFileOperations } from "./useFileOperations";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let ops!: ReturnType<typeof useFileOperations>;
function Probe() {
  ops = useFileOperations({ paneId: "p1", hostId: "h1" });
  return null;
}

it("asks for a missing username before opening SFTP to a saved host", async () => {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await ops.ensureProvider();
  });
  expect(mocks.resolveUsernameOrAsk).toHaveBeenCalledWith("p1", "h1");
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_connect_saved", {
    sessionId: "p1",
    hostId: "h1",
    username: "typed",
  });
  act(() => root.unmount());
});
