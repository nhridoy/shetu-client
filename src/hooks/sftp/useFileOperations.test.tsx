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

import { requestCertTrust } from "@/lib/storage/certTrust";
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

const certQuestion = `cert:${JSON.stringify({ kind: "untrusted", host: "nas.lan:5006", sha256: "cd".repeat(32), previous: null })}`;
function storagePane() {
  useSftpStore.setState({
    edits: [],
    root: {
      type: "leaf",
      id: "p2",
      connectionType: "storage",
      storageAccountId: "a1",
      storageName: "NAS",
      size: 100,
    } as never,
  });
}

it("saves the pin under the account's current name, not the pane's old one", async () => {
  let connects = 0;
  mocks.invoke.mockImplementation((async (cmd: string) => {
    if (cmd === "storage_connect" && connects++ === 0) throw certQuestion;
    return cmd === "storage_connect" ? "webdav" : undefined;
  }) as never);
  const save = vi.fn(async () => true);
  useStorageAccountStore.setState({
    save,
    accounts: [{ id: "a1", name: "Renamed NAS", vaultId: "v1" }],
    view: async () => ({ provider: "webdav" }),
  } as never);
  storagePane();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<BucketProbe />));
  await act(async () => {
    await ops.ensureProvider();
  });
  expect(save).toHaveBeenCalledWith("a1", "Renamed NAS", {
    trustedCertSha256: "cd".repeat(32),
  });
  act(() => root.unmount());
  mocks.invoke.mockImplementation(async () => undefined);
});

it("takes the pane's kind from the connect itself", async () => {
  mocks.invoke.mockImplementation((async (cmd: string) =>
    cmd === "storage_connect" ? "webdav" : undefined) as never);
  useStorageAccountStore.setState({
    view: async () => {
      throw new Error("locked");
    },
  } as never);
  storagePane();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<BucketProbe />));
  let provider: unknown;
  await act(async () => {
    provider = await ops.ensureProvider();
  });
  expect((provider as { kind?: string }).kind).toBe("webdav");
  act(() => root.unmount());
  mocks.invoke.mockImplementation(async () => undefined);
});

it("a pane disconnected during the certificate question doesn't save or reconnect", async () => {
  let release!: (trust: boolean) => void;
  vi.mocked(requestCertTrust).mockImplementationOnce(
    () => new Promise<boolean>((r) => (release = r)),
  );
  let connects = 0;
  mocks.invoke.mockImplementation((async (cmd: string) => {
    if (cmd === "storage_connect" && connects++ === 0) throw certQuestion;
    return cmd === "storage_connect" ? "webdav" : undefined;
  }) as never);
  const save = vi.fn(async () => true);
  useStorageAccountStore.setState({ save } as never);
  storagePane();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<BucketProbe />));
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = ops.ensureProvider().catch((e) => e);
  });
  await act(async () => {
    await ops.disconnect();
  });
  await act(async () => {
    release(true);
    await pending;
  });
  expect(save).not.toHaveBeenCalled();
  expect(connects).toBe(1);
  act(() => root.unmount());
  mocks.invoke.mockImplementation(async () => undefined);
});
