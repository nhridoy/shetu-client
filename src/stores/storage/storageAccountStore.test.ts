import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../../lib/db/db");
vi.mock("../../lib/common/device", () => ({ getDeviceId: async () => "d1" }));
vi.mock("../auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1", email: "a@b.c" } }) },
}));

import { deleteRow, listRows, notifyLocalMutation } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useStorageAccountStore } from "./storageAccountStore";

const row = {
  id: "s1",
  revision: 1,
  vault_id: "v1",
  created_at: "1970-01-01T00:00:01.000Z",
  updated_at: "1970-01-01T00:00:01.000Z",
  deleted_at: null,
  name: "Backups",
  sort_order: 0,
  data: "enc",
};

beforeEach(() => {
  vi.clearAllMocks();
  useStorageAccountStore.setState({ accounts: [], error: null });
  useVaultStore.setState({ currentVaultId: "v1" });
  h.invoke.mockImplementation(async (cmd: string, args: { name?: string }) =>
    cmd === "storage_account_save" ? { ...row, name: args.name } : null,
  );
});

describe("storageAccountStore", () => {
  it("lists accounts from the storage_accounts table", async () => {
    vi.mocked(listRows).mockResolvedValue([row]);
    await useStorageAccountStore.getState().fetchStorageAccounts();
    expect(listRows).toHaveBeenCalledWith("storage_accounts", "v1");
    expect(useStorageAccountStore.getState().accounts).toEqual([
      { id: "s1", name: "Backups", vaultId: "v1" },
    ]);
  });

  it("saves through Rust with the patch and lists the result", async () => {
    await useStorageAccountStore
      .getState()
      .save(null, "Backups", { provider: "aws", bucket: "b" });
    expect(h.invoke).toHaveBeenCalledWith("storage_account_save", {
      id: null,
      vaultId: "v1",
      name: "Backups",
      patch: { provider: "aws", bucket: "b" },
      deviceId: "d1",
    });
    expect(notifyLocalMutation).toHaveBeenCalledWith("storage_accounts", "v1");
    expect(useStorageAccountStore.getState().accounts).toHaveLength(1);
  });

  it("tests and deletes", async () => {
    h.invoke.mockResolvedValueOnce("Connected to b");
    expect(
      await useStorageAccountStore.getState().test("s1", { bucket: "b" }),
    ).toBe("Connected to b");
    expect(h.invoke).toHaveBeenCalledWith("storage_test", {
      id: "s1",
      patch: { bucket: "b" },
    });
    useStorageAccountStore.setState({
      accounts: [{ id: "s1", name: "Backups", vaultId: "v1" }],
    });
    await useStorageAccountStore.getState().remove("s1");
    expect(deleteRow).toHaveBeenCalledWith("storage_accounts", "s1");
    expect(useStorageAccountStore.getState().accounts).toEqual([]);
  });
});
