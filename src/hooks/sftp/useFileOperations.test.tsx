// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ConnectCancelled: class ConnectCancelled extends Error {},
  invoke: vi.fn(async () => undefined),
  resolveUsernameOrAsk: vi.fn(async () => "typed"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/storage/certTrust", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/certTrust")>()),
  requestCertTrust: vi.fn(async () => true),
}));
vi.mock("@/lib/terminal/agentForwarding", () => ({
  resolveUsernameOrAsk: mocks.resolveUsernameOrAsk,
  ConnectCancelled: mocks.ConnectCancelled,
}));

import { useSftpStore } from "@/stores/sftp/sftpStore";
import { useStorageAccountStore } from "@/stores/storage/storageAccountStore";
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

it("cancelling the username question stops quietly, without the connection error modal", async () => {
  mocks.resolveUsernameOrAsk.mockRejectedValueOnce(
    new mocks.ConnectCancelled("cancelled"),
  );
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  let thrown: unknown;
  await act(async () => {
    await ops.ensureProvider().catch((e) => {
      thrown = e;
    });
  });
  expect(thrown).toBeInstanceOf(mocks.ConnectCancelled);
  expect(ops.connectionErrorModal.open).toBe(false);
  expect(ops.connectionError).toBeNull();
  act(() => root.unmount());
});

function BucketProbe() {
  ops = useFileOperations({ paneId: "p2", hostId: "storage:a1" });
  return null;
}

it("trusting a certificate on connect saves the pin and retries", async () => {
  const sha = "ab".repeat(32);
  const question = `cert:${JSON.stringify({ kind: "untrusted", host: "nas.lan:5006", sha256: sha, previous: null })}`;
  let connects = 0;
  mocks.invoke.mockImplementation((async (cmd: string) => {
    if (cmd === "storage_connect" && connects++ === 0) throw question;
    return cmd === "storage_connect" ? "nas" : undefined;
  }) as never);
  const save = vi.fn(async () => true);
  useStorageAccountStore.setState({
    save,
    view: async () => ({ provider: "webdav" }),
  } as never);
  useSftpStore.setState({
    root: {
      type: "leaf",
      id: "p2",
      connectionType: "storage",
      storageAccountId: "a1",
      storageName: "NAS",
      size: 100,
    } as never,
  });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<BucketProbe />));
  await act(async () => {
    await ops.ensureProvider();
  });
  expect(save).toHaveBeenCalledWith("a1", "NAS", { trustedCertSha256: sha });
  expect(connects).toBe(2);
  act(() => root.unmount());
  mocks.invoke.mockImplementation(async () => undefined);
});
