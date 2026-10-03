import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/db");
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1", email: "a@b.c" } }) },
}));

import { decryptRowData } from "@/lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "@/lib/db/db";
import { useVaultStore } from "@/stores/vault/vaultStore";
import { useTabGroupStore } from "./tabGroupStore";

const row = {
  id: "p1",
  revision: 1,
  vault_id: "v1",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  deleted_at: null,
  name: "Operations",
  sort_order: 0,
  data: "encrypted",
};
const root = {
  type: "leaf" as const,
  id: "pane-1",
  hostId: "host-1",
  hostName: "Server",
  title: "Server",
  connectionStatus: "connected" as const,
  reconnect: null,
  size: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({ currentVaultId: "v1" });
  useTabGroupStore.setState({ tabGroups: [], error: null });
});

describe("quick preset persistence", () => {
  it("loads encrypted presets for the selected vault", async () => {
    vi.mocked(listRows).mockResolvedValue([row]);
    vi.mocked(decryptRowData).mockResolvedValue({
      layout: JSON.stringify(root),
    });
    await useTabGroupStore.getState().fetchTabGroups("v1");
    expect(listRows).toHaveBeenCalledWith("presets", "v1");
    expect(useTabGroupStore.getState().tabGroups).toMatchObject([
      { id: "p1", name: "Operations", layout: JSON.stringify(root) },
    ]);
  });

  it("creates an encrypted preset and exposes the saved ID", async () => {
    vi.mocked(upsertRow).mockResolvedValue(row);
    const created = await useTabGroupStore
      .getState()
      .createTabGroup("Operations", root);
    expect(upsertRow).toHaveBeenCalledWith(
      "presets",
      expect.objectContaining({ vault_id: "v1", name: "Operations" }),
      expect.objectContaining({ recordType: "presets" }),
    );
    expect(
      JSON.parse(vi.mocked(upsertRow).mock.calls[0][2]?.plaintext ?? "{}"),
    ).toEqual({ layout: JSON.stringify(root) });
    expect(created?.id).toBe("p1");
  });

  it("updates the saved layout and only changes state after persistence", async () => {
    vi.mocked(getRow).mockResolvedValue(row);
    vi.mocked(upsertRow).mockResolvedValue(row);
    useTabGroupStore.setState({
      tabGroups: [
        { id: "p1", name: "Operations", layout: "old", vaultId: "v1" },
      ],
    });
    await useTabGroupStore.getState().updateTabGroup("p1", root);
    expect(
      JSON.parse(vi.mocked(upsertRow).mock.calls[0][2]?.plaintext ?? "{}"),
    ).toEqual({ layout: JSON.stringify(root) });
    expect(useTabGroupStore.getState().tabGroups[0].layout).toBe(
      JSON.stringify(root),
    );
  });

  it("renames and deletes the same synced preset row", async () => {
    vi.mocked(getRow).mockResolvedValue(row);
    vi.mocked(decryptRowData).mockResolvedValue({
      layout: JSON.stringify(root),
    });
    vi.mocked(upsertRow).mockResolvedValue({ ...row, name: "New name" });
    useTabGroupStore.setState({
      tabGroups: [
        {
          id: "p1",
          name: "Operations",
          layout: JSON.stringify(root),
          vaultId: "v1",
        },
      ],
    });
    await useTabGroupStore.getState().renameTabGroup("p1", "New name");
    expect(upsertRow).toHaveBeenCalledWith(
      "presets",
      expect.objectContaining({ id: "p1", name: "New name" }),
      expect.anything(),
    );
    await useTabGroupStore.getState().deleteTabGroup("p1");
    expect(deleteRow).toHaveBeenCalledWith("presets", "p1");
    expect(useTabGroupStore.getState().tabGroups).toEqual([]);
  });
});
