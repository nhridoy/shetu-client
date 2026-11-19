// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  stopEdit: vi.fn(async () => {}),
  uploadEditNow: vi.fn(async () => {}),
  resolveEdit: vi.fn(async () => {}),
  openRemoteFile: vi.fn(async () => null),
}));
vi.mock("@/lib/sftp/edits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sftp/edits")>()),
  ...api,
}));

import type { RemoteEdit } from "@/lib/sftp/edits";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import EditConflictDialog from "./EditConflictDialog";
import EditingList from "./EditingList";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const edit = (patch: Partial<RemoteEdit> = {}): RemoteEdit => ({
  id: "e",
  sessionId: "pane-1",
  host: { hostId: "h1", host: "web-01", port: 22, username: "me" },
  remotePath: "/etc/nginx.conf",
  localPath: "/cache/e/nginx.conf",
  baseline: [10, 100],
  lastLocal: [10, 100],
  unsent: false,
  status: "watching",
  job: null,
  uploading: null,
  dirty: false,
  savingCopy: false,
  conflict: null,
  error: null,
  ...patch,
});

const roots: Root[] = [];
async function render(node: React.ReactNode) {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  roots.push(root);
  await act(async () => root.render(node));
}
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  );
const click = async (label: string) => {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  await act(async () => b.click());
};
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear();
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

describe("EditingList", () => {
  it("asks before discarding a save Shetu hadn't seen yet", async () => {
    useSftpStore.setState({ edits: [edit()] });
    api.stopEdit.mockRejectedValueOnce("unsent");
    await render(<EditingList />);
    await click("Stop");
    expect(api.stopEdit).toHaveBeenCalledWith("e", false);
    expect(text()).toContain("Changes not uploaded");
  });

  it("shows each edit with its status", async () => {
    useSftpStore.setState({
      edits: [
        edit(),
        edit({ id: "c", status: "conflict", unsent: true }),
        edit({ id: "n", status: "notUploaded", unsent: true }),
      ],
    });
    await render(<EditingList />);
    expect(text()).toContain("nginx.conf");
    expect(text()).toContain("web-01");
    expect(text()).toContain("Watching");
    expect(text()).toContain("Conflict: server copy changed");
    expect(text()).toContain("Not uploaded");
  });

  it("Stop on an unsent edit offers Upload now, Discard, Keep editing", async () => {
    useSftpStore.setState({ edits: [edit({ unsent: true })] });
    await render(<EditingList />);
    await click("Stop");
    expect(api.stopEdit).not.toHaveBeenCalled();
    expect(button("Upload now")).toBeDefined();
    expect(button("Keep editing")).toBeDefined();
    await click("Discard");
    expect(api.stopEdit).toHaveBeenCalledWith("e", true);
  });

  it("Stop on a sent edit stops at once", async () => {
    useSftpStore.setState({ edits: [edit()] });
    await render(<EditingList />);
    await click("Stop");
    expect(api.stopEdit).toHaveBeenCalledWith("e", false);
  });

  it("mirrors edits://changed", () => {
    useSftpStore.getState().applyEdits([edit({ id: "x" })]);
    expect(useSftpStore.getState().edits.map((e) => e.id)).toEqual(["x"]);
  });
});

describe("EditConflictDialog", () => {
  it("conflict dialog buttons call edit_resolve with the right choice", async () => {
    for (const [label, choice] of [
      ["Overwrite server", "overwrite"],
      ["Keep server's version", "keepServer"],
      ["Save mine as a copy", "saveAsCopy"],
    ] as const) {
      useSftpStore.setState({
        editConflict: {
          id: "e",
          fileName: "nginx.conf",
          host: "web-01",
          remotePath: "/etc/nginx.conf",
        },
      });
      await render(<EditConflictDialog />);
      expect(text()).toContain(
        "nginx.conf changed on web-01 since you opened it.",
      );
      await click(label);
      expect(api.resolveEdit).toHaveBeenLastCalledWith("e", choice);
      expect(useSftpStore.getState().editConflict).toBeNull();
      for (const r of roots.splice(0)) act(() => r.unmount());
      document.body.innerHTML = "";
    }
  });
});
