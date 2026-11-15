import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: m.toastError } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));

import { useHostStore } from "@/stores/hosts/hostStore";
import {
  answerUsername,
  askUsername,
  dropPendingCredentials,
  forgetSession,
  isSavedHostSession,
  registerSavedHostSession,
  rememberCredentials,
  savePendingCredentials,
  useUsernameAsks,
} from "./pendingCredentials";

const updateHost = vi.fn(async () => true);

function hostAuth(authType: string) {
  useHostStore.setState({
    hosts: [{ id: "h1", authType }],
    updateHost,
  } as never);
}

beforeEach(() => {
  updateHost.mockReset().mockResolvedValue(true);
  m.toastError.mockReset();
  forgetSession("s1");
  hostAuth("none");
  registerSavedHostSession("s1", "h1");
});

describe("pending credentials", () => {
  it("knows which sessions are saved-host terminal connects", () => {
    expect(isSavedHostSession("s1")).toBe(true);
    expect(isSavedHostSession("sftp-1")).toBe(false);
    forgetSession("s1");
    expect(isSavedHostSession("s1")).toBe(false);
  });

  it("saves a password after connected and lets the store derive authType", async () => {
    rememberCredentials("s1", { password: "pw" });
    await savePendingCredentials("s1");
    expect(updateHost).toHaveBeenCalledWith(
      "h1",
      { password: "pw" },
      { passwordAuth: true },
    );
  });

  it("saves a username alone without touching authType", async () => {
    rememberCredentials("s1", { username: "deploy" });
    await savePendingCredentials("s1");
    expect(updateHost).toHaveBeenCalledWith(
      "h1",
      { username: "deploy" },
      { passwordAuth: false },
    );
  });

  it("merges username and password remembered for one session", async () => {
    rememberCredentials("s1", { username: "deploy" });
    rememberCredentials("s1", { password: "pw" });
    await savePendingCredentials("s1");
    expect(updateHost).toHaveBeenCalledWith(
      "h1",
      { username: "deploy", password: "pw" },
      { passwordAuth: true },
    );
  });

  it("an unchecked retry replaces a password marked to save", async () => {
    rememberCredentials("s1", { password: "wrong" });
    rememberCredentials("s1", { password: undefined });
    await savePendingCredentials("s1");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("saves once, then forgets", async () => {
    rememberCredentials("s1", { password: "pw" });
    await savePendingCredentials("s1");
    await savePendingCredentials("s1");
    expect(updateHost).toHaveBeenCalledTimes(1);
  });

  it("dropped credentials are never saved", async () => {
    rememberCredentials("s1", { password: "pw" });
    dropPendingCredentials("s1");
    await savePendingCredentials("s1");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("ignores credentials for sessions that are not saved-host connects", async () => {
    rememberCredentials("sftp-1", { password: "pw" });
    await savePendingCredentials("sftp-1");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("a new connect attempt starts with nothing pending", async () => {
    rememberCredentials("s1", { password: "pw" });
    registerSavedHostSession("s1", "h1");
    await savePendingCredentials("s1");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("toasts when the save fails", async () => {
    updateHost.mockResolvedValue(false);
    rememberCredentials("s1", { password: "pw" });
    await savePendingCredentials("s1");
    expect(m.toastError).toHaveBeenCalledWith(
      "Couldn't save credentials to this host",
    );
  });
});

describe("askUsername", () => {
  beforeEach(() => useUsernameAsks.setState({ queue: [] }));

  it("queues the question and resolves with the answer", async () => {
    const answer = askUsername("s1", "prod");
    expect(useUsernameAsks.getState().queue[0].host).toBe("prod");
    answerUsername({ username: "deploy", save: true });
    await expect(answer).resolves.toEqual({ username: "deploy", save: true });
    expect(useUsernameAsks.getState().queue).toHaveLength(0);
  });

  it("a closed pane's question is answered with null and removed", async () => {
    const closed = askUsername("s1", "prod");
    const other = askUsername("s2", "web");
    forgetSession("s1");
    await expect(closed).resolves.toBeNull();
    expect(useUsernameAsks.getState().queue.map((a) => a.host)).toEqual([
      "web",
    ]);
    answerUsername(null);
    await other;
  });

  it("resolves null on cancel", async () => {
    const answer = askUsername("s1", "prod");
    answerUsername(null);
    await expect(answer).resolves.toBeNull();
  });
});
