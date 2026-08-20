import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasDirtyFiles, ROOT_VIEW_ID, useEditorStore } from "./editorStore";

const mockEnsureRemoteSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/editor/editorProvider", () => ({
  ensureRemoteSession: mockEnsureRemoteSession,
}));

beforeEach(() => {
  useEditorStore.setState({
    connectionType: null,
    viewTrees: null,
    activeView: null,
    openFiles: {},
    activeFile: {},
    previewFile: {},
    fileContent: {},
    fileDirty: {},
    explorerDirs: {},
    explorerSelectedPath: null,
    explorerRootPath: null,
    quickOpenOpen: false,
    revealRequest: null,
    statusVersion: 0,
  });
  mockEnsureRemoteSession.mockReset();
});

describe("editorStore connection", () => {
  it("connectRemote sets host fields, root path, and opens the target file", () => {
    useEditorStore.getState().connectRemote({
      hostId: "h1",
      hostName: "web-prod",
      hostAddress: "192.168.1.10",
      hostPort: 22,
      hostUsername: "deploy",
      sessionId: "pane-1",
      rootPath: "/var/www/app",
      fileToOpen: { path: "/var/www/app/index.ts", name: "index.ts" },
    });

    const s = useEditorStore.getState();
    expect(s.connectionType).toBe("host");
    expect(s.hostId).toBe("h1");
    expect(s.sessionId).toBe("pane-1");
    expect(s.explorerRootPath).toBe("/var/www/app");
    expect(s.openFiles[ROOT_VIEW_ID]).toEqual([
      { path: "/var/www/app/index.ts", name: "index.ts", kind: "file" },
    ]);
    expect(s.activeFile[ROOT_VIEW_ID]).toBe("/var/www/app/index.ts");
  });

  it("connectRemote without a target file leaves the tree empty", () => {
    useEditorStore.getState().connectRemote({
      hostId: "h1",
      sessionId: "pane-1",
      rootPath: "/var/www/app",
    });
    expect(
      useEditorStore.getState().openFiles[ROOT_VIEW_ID] ?? [],
    ).toHaveLength(0);
  });

  it("connectLocal switches to a local connection and clears buffers", () => {
    useEditorStore.setState({
      fileContent: { "/a.txt": "unsaved" },
      fileDirty: { "/a.txt": true },
    });
    useEditorStore.getState().connectLocal("/work");
    const s = useEditorStore.getState();
    expect(s.connectionType).toBe("local");
    expect(s.localPath).toBe("/work");
    expect(s.fileContent).toEqual({});
    expect(s.fileDirty).toEqual({});
  });

  it("connectLocal opens a target file when provided", () => {
    useEditorStore.getState().connectLocal("/work", {
      path: "/work/a.txt",
      name: "a.txt",
    });
    const s = useEditorStore.getState();
    expect(s.connectionType).toBe("local");
    expect(s.localPath).toBe("/work");
    expect(s.activeFile[ROOT_VIEW_ID]).toBe("/work/a.txt");
    expect(s.openFiles[ROOT_VIEW_ID]).toEqual([
      { path: "/work/a.txt", name: "a.txt", kind: "file" },
    ]);
  });

  it("disconnect clears the connection and all open files", () => {
    useEditorStore.getState().connectRemote({
      hostId: "h1",
      sessionId: "pane-1",
      rootPath: "/srv",
    });
    useEditorStore.getState().openFile("/srv/a.txt", "a.txt", false);
    useEditorStore.getState().setFileContent("/srv/a.txt", "text");
    useEditorStore.getState().setFileDirty("/srv/a.txt", true);
    useEditorStore.getState().disconnect();
    const s = useEditorStore.getState();
    expect(s.connectionType).toBeNull();
    expect(s.openFiles).toEqual({});
    expect(s.fileContent).toEqual({});
    expect(s.fileDirty).toEqual({});
  });
});

describe("file buffers", () => {
  it("setFileContent and setFileDirty persist across view switches", () => {
    useEditorStore.getState().setFileContent("/a.txt", "hello");
    useEditorStore.getState().setFileDirty("/a.txt", true);
    const s = useEditorStore.getState();
    expect(s.fileContent["/a.txt"]).toBe("hello");
    expect(s.fileDirty["/a.txt"]).toBe(true);
  });

  it("setFileDirty false clears the flag", () => {
    useEditorStore.getState().setFileDirty("/a.txt", true);
    useEditorStore.getState().setFileDirty("/a.txt", false);
    expect(useEditorStore.getState().fileDirty["/a.txt"]).toBe(false);
  });

  it("hasDirtyFiles detects any dirty file", () => {
    expect(hasDirtyFiles(useEditorStore.getState())).toBe(false);
    useEditorStore.getState().setFileDirty("/a.txt", true);
    expect(hasDirtyFiles(useEditorStore.getState())).toBe(true);
  });
});

describe("reconnect", () => {
  it("returns false when not connected to a remote", async () => {
    const ok = await useEditorStore.getState().reconnect();
    expect(ok).toBe(false);
    expect(mockEnsureRemoteSession).not.toHaveBeenCalled();
  });

  it("returns true and rebuilds the session on success", async () => {
    useEditorStore.getState().connectRemote({
      hostId: "h1",
      sessionId: "pane-1",
      rootPath: "/srv",
    });
    mockEnsureRemoteSession.mockResolvedValue({});
    const ok = await useEditorStore.getState().reconnect();
    expect(ok).toBe(true);
    expect(mockEnsureRemoteSession).toHaveBeenCalledTimes(1);
  });

  it("returns false when the session rebuild fails", async () => {
    useEditorStore.getState().connectRemote({
      hostId: "h1",
      sessionId: "pane-1",
      rootPath: "/srv",
    });
    mockEnsureRemoteSession.mockRejectedValue(new Error("boom"));
    const ok = await useEditorStore.getState().reconnect();
    expect(ok).toBe(false);
  });
});
