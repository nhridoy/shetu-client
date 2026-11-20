// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadComparison: vi.fn(),
  deleteEntry: vi.fn(async () => {}),
}));
vi.mock("@/lib/sftp/folderCompare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/folderCompare")>()),
  loadComparison: mocks.loadComparison,
  deleteEntry: mocks.deleteEntry,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn() }),
}));

import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import { useFolderCompare } from "./useFolderCompare";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setPath = (id: string, currentPath: string) =>
  useFileBrowserStore.setState((s) => ({
    panes: { ...s.panes, [id]: { ...s.panes[id], currentPath } },
  }));

let api: ReturnType<typeof useFolderCompare> | undefined;
function Probe() {
  api = useFolderCompare("L", "R");
  return null;
}

describe("useFolderCompare", () => {
  beforeEach(() => {
    useSftpStore.setState({
      root: {
        type: "split",
        id: "s",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "L", connectionType: "local", size: 50 },
          { type: "leaf", id: "R", connectionType: "local", size: 50 },
        ],
      } as never,
    });
  });

  it("acts on the folders the rows came from while a newer scan is loading", async () => {
    setPath("L", "/old");
    setPath("R", "/right");
    const row = { path: "x.txt", status: "onlyLeft", isDir: false } as const;
    mocks.loadComparison.mockResolvedValueOnce([row]);
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () => root.render(<Probe />));
    expect(api?.rows).toEqual([row]);

    setPath("L", "/new");
    mocks.loadComparison.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => void api?.rescan());
    mocks.loadComparison.mockReturnValue(new Promise(() => {}));
    await act(async () => void api?.remove(row));
    expect(mocks.deleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/old" }),
      "x.txt",
    );
    act(() => root.unmount());
  });
  it("an action from an older render uses that render's folders", async () => {
    setPath("L", "/first");
    setPath("R", "/right");
    const row = { path: "y.txt", status: "onlyLeft", isDir: false } as const;
    mocks.loadComparison.mockResolvedValueOnce([row]);
    mocks.deleteEntry.mockClear();
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () => root.render(<Probe />));
    const old = api;
    setPath("L", "/second");
    mocks.loadComparison.mockResolvedValueOnce([row]);
    await act(async () => void (await api?.rescan()));
    mocks.loadComparison.mockReturnValue(new Promise(() => {}));
    await act(async () => void old?.remove(row));
    expect(mocks.deleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/first" }),
      "y.txt",
    );
    act(() => root.unmount());
  });

  it("a bucket pane is a storage side", async () => {
    const { sideOf } = await import("./useFolderCompare");
    useSftpStore.setState({
      root: {
        type: "leaf",
        id: "B",
        connectionType: "storage",
        storageAccountId: "acc",
        size: 100,
      } as never,
    });
    setPath("B", "/photos");
    expect(sideOf("B")).toMatchObject({ kind: "storage", root: "/photos" });
  });

  it("drops the rows and refuses old actions once a pane reconnects elsewhere", async () => {
    setPath("L", "/a");
    setPath("R", "/right");
    const row = { path: "z.txt", status: "onlyLeft", isDir: false } as const;
    mocks.loadComparison.mockResolvedValueOnce([row]);
    mocks.deleteEntry.mockClear();
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () => root.render(<Probe />));
    const old = api;
    expect(old?.rows).toEqual([row]);
    // L reconnects to a bucket; its rescan is still loading.
    mocks.loadComparison.mockReturnValue(new Promise(() => {}));
    await act(async () =>
      useSftpStore.setState({
        root: {
          type: "split",
          id: "s",
          direction: "horizontal",
          children: [
            {
              type: "leaf",
              id: "L",
              connectionType: "storage",
              storageAccountId: "b2",
              size: 50,
            },
            { type: "leaf", id: "R", connectionType: "local", size: 50 },
          ],
        } as never,
      }),
    );
    expect(api?.rows).toEqual([]);
    await act(async () => void (await old?.remove(row)));
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
