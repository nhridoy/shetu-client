// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

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
  it("acts on the folders the rows came from while a newer scan is loading", async () => {
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
});
