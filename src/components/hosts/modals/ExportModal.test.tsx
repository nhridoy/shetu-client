// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  write: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: h.write }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn() } }));
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: (pick: (s: { currentVaultId: string }) => unknown) =>
    pick({ currentVaultId: "v1" }),
}));

import ExportModal from "./ExportModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const onClose = vi.fn();
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement;
const text = () => document.body.textContent ?? "";

async function render(groupId: string | null = "g1") {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(<ExportModal groupId={groupId} onClose={onClose} />),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  h.invoke.mockResolvedValue("Host a\n");
  h.write.mockResolvedValue(undefined);
});

describe("ExportModal", () => {
  it("exports each format to the picked file", async () => {
    h.save.mockResolvedValue("/tmp/out.conf");
    await render();
    await act(async () => button("SSH config").click());
    expect(h.invoke).toHaveBeenCalledWith("export_hosts", {
      vaultId: "v1",
      groupId: "g1",
      format: "ssh_config",
    });
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "shetu-hosts.conf" }),
    );
    expect(h.write).toHaveBeenCalledWith("/tmp/out.conf", "Host a\n");
    expect(h.success).toHaveBeenCalledWith("Exported to out.conf");
    expect(onClose).toHaveBeenCalled();

    h.save.mockResolvedValue("/tmp/hosts.csv");
    document.body.innerHTML = "";
    await render(null);
    await act(async () => button("CSV").click());
    expect(h.invoke).toHaveBeenLastCalledWith("export_hosts", {
      vaultId: "v1",
      groupId: null,
      format: "csv",
    });
    expect(h.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: "shetu-hosts.csv" }),
    );
  });

  it("a cancelled save writes nothing and stays open", async () => {
    h.save.mockResolvedValue(null);
    await render();
    await act(async () => button("CSV").click());
    expect(h.write).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error and stays open", async () => {
    h.invoke.mockRejectedValue("database locked");
    await render();
    await act(async () => button("CSV").click());
    expect(text()).toContain("database locked");
    expect(onClose).not.toHaveBeenCalled();
  });
});
