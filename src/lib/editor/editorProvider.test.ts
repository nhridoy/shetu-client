import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FileProvider, LocalFileProvider } from "@/lib/sftp/fileTransfer";
import {
  getProvider,
  registerProvider,
  unregisterProvider,
} from "@/lib/sftp/providerRegistry";
import {
  ensureRemoteSession,
  getEditorProvider,
  providerReadText,
  providerWriteText,
} from "./editorProvider";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const { RemoteFileProviderImpl } = await import("@/lib/sftp/remoteFs");

const savedConfig = {
  connectionType: "host" as const,
  hostId: "h1",
  hostAddress: "192.168.1.5",
  hostPort: 22,
  hostUsername: "root",
  sessionId: "sess-1",
};

const directConfig = {
  connectionType: "host" as const,
  hostId: "direct_h1",
  hostAddress: "10.0.0.1",
  hostPort: 2222,
  hostUsername: "admin",
  sessionId: "sess-2",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({});
  unregisterProvider("sess-1");
  unregisterProvider("sess-2");
});

describe("getEditorProvider", () => {
  it("returns a LocalFileProvider for local connections", () => {
    const provider = getEditorProvider({ connectionType: "local" });
    expect(provider).toBeInstanceOf(LocalFileProvider);
    expect(provider.type).toBe("local");
  });

  it("reuses a registered provider for an active remote session", () => {
    const existing = new RemoteFileProviderImpl("h1", "sess-1");
    registerProvider("sess-1", existing);
    const provider = getEditorProvider(savedConfig);
    expect(provider).toBe(existing);
    expect(getProvider("sess-1")).toBe(existing);
  });

  it("creates and registers a remote provider when none is registered", () => {
    const provider = getEditorProvider(savedConfig);
    expect(provider).toBeInstanceOf(RemoteFileProviderImpl);
    expect(getProvider("sess-1")).toBe(provider);
  });

  it("throws when there is no active connection", () => {
    expect(() => getEditorProvider({ connectionType: null })).toThrow(
      "No active editor connection",
    );
  });
});

describe("ensureRemoteSession", () => {
  it("connects a saved host via sftp_connect_saved", async () => {
    const provider = await ensureRemoteSession(savedConfig);
    expect(mockInvoke).toHaveBeenCalledWith("sftp_connect_saved", {
      sessionId: "sess-1",
      hostId: "h1",
    });
    expect(provider).toBeInstanceOf(RemoteFileProviderImpl);
  });

  it("connects a direct host via sftp_connect with a config", async () => {
    await ensureRemoteSession(directConfig);
    expect(mockInvoke).toHaveBeenCalledWith("sftp_connect", {
      sessionId: "sess-2",
      config: {
        host: "10.0.0.1",
        port: 2222,
        username: "admin",
      },
    });
  });

  it("reuses an existing registered provider after connecting", async () => {
    const existing = new RemoteFileProviderImpl("h1", "sess-1");
    registerProvider("sess-1", existing);
    const provider = await ensureRemoteSession(savedConfig);
    expect(provider).toBe(existing);
  });

  it("throws when there is no active remote connection", async () => {
    await expect(ensureRemoteSession({ connectionType: null })).rejects.toThrow(
      "No active remote connection",
    );
  });
});

describe("provider text helpers", () => {
  it("round-trips a string through read and write", async () => {
    const store = new Map<string, Uint8Array>();
    const provider: FileProvider = {
      type: "local",
      id: "fake",
      listFiles: vi.fn(),
      listFilesRecursive: vi.fn(),
      isDirectory: vi.fn(),
      readFile: async (path: string) => store.get(path) ?? new Uint8Array(),
      writeFile: async (path: string, data: Uint8Array) => {
        store.set(path, data);
      },
      moveFile: vi.fn(),
      copyFile: vi.fn(),
      removeFile: vi.fn(),
      exists: vi.fn(),
      mkdir: vi.fn(),
      mkdirAll: vi.fn(),
    };
    const sample = "hello world\n\u00e9\u4f60\u597d";
    await providerWriteText(provider, "/tmp/a.txt", sample);
    const out = await providerReadText(provider, "/tmp/a.txt");
    expect(out).toBe(sample);
  });
});
