// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareRow } from "@/lib/sftp/compareFolders";

const mocks = vi.hoisted(() => ({
  loadComparison: vi.fn(),
  copyRows: vi.fn(async () => []),
  deleteEntry: vi.fn(async () => {}),
  withBucketTimes: vi.fn(async (rows: unknown) => rows),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/lib/sftp/folderCompare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/folderCompare")>()),
  loadComparison: mocks.loadComparison,
  copyRows: mocks.copyRows,
  deleteEntry: mocks.deleteEntry,
  withBucketTimes: mocks.withBucketTimes,
}));

import { useFileBrowserStore } from "@/stores/sftp/fileBrowserStore";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import CompareView from "./CompareView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const e = (path: string, size = 1) => ({
  path,
  isDir: false,
  size,
  mtime: 100,
});
const row = (path: string, status: CompareRow["status"]): CompareRow => ({
  path,
  status,
  isDir: false,
  left: status === "onlyRight" ? undefined : e(path),
  right: status === "onlyLeft" ? undefined : e(path, 2),
});
const ROWS = [
  row("new.txt", "onlyLeft"),
  row("old.js", "onlyRight"),
  row("index.html", "differs"),
  row("same.css", "same"),
  row("clash", "conflict"),
];

const roots: Root[] = [];
async function render() {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  roots.push(root);
  await act(async () => {
    root.render(
      <CompareView leftPaneId="L" rightPaneId="R" onClose={() => {}} />,
    );
  });
}
const text = () => document.body.textContent ?? "";
const rowEl = (path: string) =>
  [...document.querySelectorAll("[data-compare-row]")].find(
    (el) => el.getAttribute("data-compare-row") === path,
  );
const labels = (el?: Element) =>
  [...(el?.querySelectorAll("button") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  );
const click = async (el: Element | undefined | null) => {
  if (!el) throw new Error("missing element");
  await act(async () => (el as HTMLElement).click());
};
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.loadComparison.mockResolvedValue(ROWS);
  useSftpStore.setState({
    root: {
      type: "split",
      id: "s",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "L", connectionType: "local", size: 50 },
        {
          type: "leaf",
          id: "R",
          connectionType: "host",
          hostId: "h1",
          hostName: "web-01",
          size: 50,
        },
      ],
    } as never,
  });
  useFileBrowserStore.setState((s) => ({
    panes: {
      ...s.panes,
      L: { ...(s.panes.L ?? {}), currentPath: "/home/me/site" },
      R: { ...(s.panes.R ?? {}), currentPath: "/var/www/site" },
    } as never,
  }));
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CompareView", () => {
  it("shows arrows per status and hides identical rows by default", async () => {
    await render();
    expect(labels(rowEl("new.txt"))).toContain("Copy to right");
    expect(labels(rowEl("new.txt"))).not.toContain("Copy to left");
    expect(labels(rowEl("old.js"))).toContain("Copy to left");
    expect(labels(rowEl("index.html"))).toEqual(
      expect.arrayContaining(["Copy to right", "Copy to left"]),
    );
    expect(rowEl("same.css")).toBeUndefined();
    await click(button("Show identical (1)"));
    expect(rowEl("same.css")).toBeDefined();
  });

  it("never offers copy on a conflict row", async () => {
    await render();
    const clash = rowEl("clash");
    expect(clash).toBeDefined();
    expect(labels(clash)).not.toContain("Copy to right");
    expect(labels(clash)).not.toContain("Copy to left");
    expect(clash?.textContent).toContain("different types");
  });

  it("asks before deleting and only offers delete on target-only rows", async () => {
    await render();
    expect(labels(rowEl("index.html"))).not.toContain("Delete");
    expect(labels(rowEl("new.txt"))).toContain("Delete");
    window.confirm = vi.fn(() => false);
    await click(button("Delete", rowEl("old.js")));
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
    window.confirm = vi.fn(() => true);
    await click(button("Delete", rowEl("old.js")));
    expect(mocks.deleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/var/www/site" }),
      "old.js",
    );
  });

  it("Sync → copies through copyRows then rescans", async () => {
    await render();
    await click(button("Sync →"));
    expect(mocks.copyRows).toHaveBeenCalledWith(
      ROWS,
      "right",
      expect.objectContaining({ kind: "local", root: "/home/me/site" }),
      expect.objectContaining({ kind: "remote", root: "/var/www/site" }),
      expect.any(Function),
    );
    expect(mocks.loadComparison).toHaveBeenCalledTimes(2);
  });

  it("asks before Sync replaces newer files on the other side", async () => {
    const newer: CompareRow = {
      path: "config.php",
      status: "differs",
      isDir: false,
      left: e("config.php"),
      right: { ...e("config.php", 2), mtime: 500 },
    };
    mocks.loadComparison.mockResolvedValue([newer]);
    await render();
    window.confirm = vi.fn(() => false);
    await click(button("Sync →"));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("1 file on the other side is newer"),
    );
    expect(mocks.copyRows).not.toHaveBeenCalled();
    window.confirm = vi.fn(() => true);
    await click(button("Sync →"));
    expect(mocks.copyRows).toHaveBeenCalled();
  });

  it("shows a listing error instead of rows", async () => {
    mocks.loadComparison.mockRejectedValueOnce(new Error("Permission denied"));
    await render();
    expect(text()).toContain("Permission denied");
    expect(document.querySelectorAll("[data-compare-row]")).toHaveLength(0);
  });

  it("names a bucket pane by its account", async () => {
    useSftpStore.setState({
      root: {
        type: "split",
        id: "s",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "L", connectionType: "local", size: 50 },
          {
            type: "leaf",
            id: "R",
            connectionType: "storage",
            storageAccountId: "a1",
            storageName: "Photos",
            size: 50,
          },
        ],
      } as never,
    });
    await render();
    expect(text()).toContain("Photos: /var/www/site");
  });

  it("says so and copies nothing when the newer-file check can't run", async () => {
    mocks.withBucketTimes.mockRejectedValueOnce(new Error("stat: timed out"));
    await render();
    await click(button("Copy to right", rowEl("index.html")));
    expect(mocks.copyRows).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
    );
  });

  it("rescans when a pane connects somewhere else", async () => {
    await render();
    expect(mocks.loadComparison).toHaveBeenCalledTimes(1);
    await act(async () =>
      useSftpStore.setState({
        root: {
          type: "split",
          id: "s",
          direction: "horizontal",
          children: [
            { type: "leaf", id: "L", connectionType: "local", size: 50 },
            {
              type: "leaf",
              id: "R",
              connectionType: "host",
              hostId: "h2",
              hostName: "web-02",
              size: 50,
            },
          ],
        } as never,
      }),
    );
    expect(mocks.loadComparison).toHaveBeenCalledTimes(2);
  });
});
