import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteFileProviderImpl } from "./remoteFs";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  name: "file.txt",
  path: "/file.txt",
  is_dir: false,
  is_symlink: false,
  size: 10,
  mode: 0o644,
  uid: 1000,
  gid: 1000,
  mtime: 1000,
  atime: 2000,
  symlink_target: null,
  ...overrides,
});

describe("RemoteFileProviderImpl", () => {
  const provider = new RemoteFileProviderImpl("host-1", "sess-1");

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("maps SftpEntry fields, including atime -> accessedAt", async () => {
    mockInvoke.mockResolvedValue([
      makeEntry(),
      makeEntry({
        name: "dir",
        path: "/dir",
        is_dir: true,
        size: 0,
        mode: 0o755,
        mtime: 3000,
        atime: 4000,
      }),
    ]);

    const files = await provider.listFiles("/");

    expect(files).toHaveLength(2);
    // atime is seconds; accessedAt is ISO from atime*1000 ms
    expect(files[0].accessedAt).toBe(new Date(2000 * 1000).toISOString());
    expect(files[0].modifiedAt).toBe(new Date(1000 * 1000).toISOString());
    expect(files[0].permissions).toBe("rw-r--r--");
    expect(files[1].type).toBe("directory");
    expect(files[1].permissions).toBe("rwxr-xr-x");
  });

  it("passes sessionId and path to sftp_list", async () => {
    mockInvoke.mockResolvedValue([]);
    await provider.listFiles("/home");

    expect(mockInvoke).toHaveBeenCalledWith("sftp_list", {
      sessionId: "sess-1",
      path: "/home",
    });
  });

  it("search maps entries and forwards the query", async () => {
    mockInvoke.mockResolvedValue([
      makeEntry({
        name: "a.txt",
        path: "/a.txt",
        mode: 0o600,
        mtime: 1,
        atime: 1,
      }),
    ]);

    const results = await provider.search("/", "a");

    expect(mockInvoke).toHaveBeenCalledWith("sftp_search", {
      sessionId: "sess-1",
      path: "/",
      query: "a",
    });
    expect(results[0].accessedAt).toBe(new Date(1 * 1000).toISOString());
    expect(results[0].permissions).toBe("rw-------");
  });

  it("stat delegates to sftp_stat with the session path", async () => {
    mockInvoke.mockResolvedValue(makeEntry({ name: "x", path: "/x" }));

    const item = await provider.stat("/x");

    expect(mockInvoke).toHaveBeenCalledWith("sftp_stat", {
      sessionId: "sess-1",
      path: "/x",
    });
    expect(item.name).toBe("x");
  });
});
