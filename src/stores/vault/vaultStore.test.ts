import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../lib/db/db", () => ({
  listRows: vi.fn(),
  upsertRow: vi.fn(),
  deleteRow: vi.fn(),
}));
vi.mock("../../lib/api/auth", () => ({
  authApi: { fetchDefaultVault: vi.fn() },
}));
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "u1", email: "a@b.c" } }),
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { authApi } from "../../lib/api/auth";
import { deleteRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "./vaultStore";

const mockDefaultVault = vi.mocked(authApi.fetchDefaultVault);
const mockList = vi.mocked(listRows);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);

const vaultRow = (overrides: Record<string, unknown> = {}) => ({
  id: "v1",
  revision: 1,
  vault_id: "",
  created_at: "2023-11-14T22:13:20.000Z",
  updated_at: "2023-11-14T22:13:20.000Z",
  deleted_at: null,
  name: "Personal",
  owner_id: "u1",
  kind: "team",
  sort_order: 0,
  is_default: 1,
  data: "enc",
  ...overrides,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(false);
  mockDefaultVault.mockReset();
  mockDefaultVault.mockResolvedValue({
    id: "v1",
    owner_id: "u1",
    name: "Personal",
    kind: "personal",
    sort_order: 0,
    is_default: true,
  });
  mockList.mockReset();
  mockUpsert.mockReset();
  mockDelete.mockReset();
  mockList.mockResolvedValue([]);
  mockUpsert.mockResolvedValue(vaultRow());
  mockDelete.mockResolvedValue(undefined);
  useVaultStore.setState({
    vaults: [],
    currentVaultId: null,
    decryptedData: null,
    isLoading: false,
    error: null,
  });
});

describe("vaultStore", () => {
  it("fetchVaults reads via the generic db_list and auto-selects the default vault", async () => {
    mockList.mockResolvedValue([
      vaultRow({ is_default: 1 }),
      vaultRow({
        id: "v2",
        kind: "team",
        name: "Team",
        created_at: "2023-11-14T22:13:21.000Z",
        updated_at: "2023-11-14T22:13:21.000Z",
      }),
    ]);

    await useVaultStore.getState().fetchVaults();

    expect(mockList).toHaveBeenCalledWith("vaults", "");
    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults).toHaveLength(2);
    expect(currentVaultId).toBe("v1");
    expect(vaults[0]).toMatchObject({
      id: "v1",
      name: "Personal",
      isDefault: true,
      isSystem: true,
    });
  });

  it("mirrors the server-seeded default when local SQLite is empty", async () => {
    mockList.mockResolvedValue([]);
    mockUpsert.mockResolvedValue(vaultRow());

    await useVaultStore.getState().fetchVaults();

    expect(mockDefaultVault).toHaveBeenCalledOnce();
    expect(mockUpsert).toHaveBeenCalledWith(
      "vaults",
      expect.objectContaining({
        id: "v1",
        owner_id: "u1",
        name: "Personal",
        is_default: 1,
      }),
    );
    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults).toHaveLength(1);
    expect(currentVaultId).toBe("v1");
  });

  it("fetchVaults does not create vaults, only reads local rows", async () => {
    mockList.mockResolvedValue([vaultRow()]);

    await useVaultStore.getState().fetchVaults();

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(useVaultStore.getState().vaults).toHaveLength(1);
  });

  it("keeps app-created vaults and adds the missing server default", async () => {
    mockList.mockResolvedValue([
      vaultRow({ id: "old-1", kind: "personal", name: "Old", is_default: 0 }),
      vaultRow({ id: "old-2", kind: "personal", name: "Older", is_default: 0 }),
    ]);

    await useVaultStore.getState().fetchVaults();

    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults).toHaveLength(3);
    expect(vaults.filter((v) => v.isSystem).map((v) => v.id)).toEqual(["v1"]);
    expect(currentVaultId).toBe("v1");
  });

  it("createVault upserts locally, appends and switches to the new vault", async () => {
    mockList.mockResolvedValue([vaultRow()]);
    await useVaultStore.getState().fetchVaults();

    mockUpsert.mockResolvedValue(
      vaultRow({
        id: "new",
        name: "Production",
        created_at: "2023-11-14T22:13:22.000Z",
      }),
    );

    await useVaultStore
      .getState()
      .createVault("Production", "personal", "prod cluster");

    expect(mockUpsert).toHaveBeenCalledWith(
      "vaults",
      expect.objectContaining({
        owner_id: "u1",
        kind: "personal",
        is_default: 0,
        name: "Production",
      }),
      { plaintext: "{}", recordType: "vaults" },
    );
    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults).toHaveLength(2);
    const created = vaults.find((v) => v.name === "Production");
    expect(created).toBeDefined();
    expect(created?.description).toBe("prod cluster");
    expect(currentVaultId).toBe(created?.id);
  });

  it("rejects creating a fake shared vault through the generic vault store", async () => {
    await expect(
      useVaultStore.getState().createVault("Team", "team"),
    ).rejects.toThrow("Teams page");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("switchVault sets currentVaultId", async () => {
    await useVaultStore.getState().switchVault("v2");
    expect(useVaultStore.getState().currentVaultId).toBe("v2");
  });

  it("updateVault upserts changes and replaces the item in state", async () => {
    mockList.mockResolvedValue([vaultRow()]);
    await useVaultStore.getState().fetchVaults();

    mockUpsert.mockResolvedValue(
      vaultRow({ name: "Renamed", updated_at: "2023-11-14T22:13:23.000Z" }),
    );

    await useVaultStore.getState().updateVault("v1", {
      name: "Renamed",
      description: "renamed",
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      "vaults",
      expect.objectContaining({ id: "v1", name: "Renamed" }),
      { plaintext: "{}", recordType: "vaults" },
    );
    const updated = useVaultStore.getState().vaults.find((v) => v.id === "v1");
    expect(updated?.name).toBe("Renamed");
    expect(updated?.description).toBe("renamed");
  });

  it("deleteVault removes the row and falls back to the first remaining vault", async () => {
    mockList.mockResolvedValue([
      vaultRow(),
      vaultRow({
        id: "v2",
        kind: "team",
        name: "Team",
        created_at: "2023-11-14T22:13:21.000Z",
        updated_at: "2023-11-14T22:13:21.000Z",
      }),
    ]);
    await useVaultStore.getState().fetchVaults();

    await useVaultStore.getState().deleteVault("v1");

    expect(mockDelete).toHaveBeenCalledWith("vaults", "v1");
    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults.map((v) => v.id)).toEqual(["v2"]);
    expect(currentVaultId).toBe("v2");
  });

  it("deleteVault clears currentVaultId when no vaults remain", async () => {
    mockList.mockResolvedValue([vaultRow()]);
    await useVaultStore.getState().fetchVaults();

    await useVaultStore.getState().deleteVault("v1");

    expect(useVaultStore.getState().currentVaultId).toBeNull();
  });

  it("blocks generic edits and deletion for a true shared vault", async () => {
    mockList.mockResolvedValue([vaultRow({ id: "shared", is_default: 1 })]);
    await useVaultStore.getState().fetchVaults();
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(
      useVaultStore.getState().updateVault("shared", { name: "Bad" }),
    ).rejects.toThrow("Teams page");
    await expect(
      useVaultStore.getState().deleteVault("shared"),
    ).rejects.toThrow("Teams page");
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("clearError resets the error field", () => {
    useVaultStore.setState({ error: "boom" });
    useVaultStore.getState().clearError();
    expect(useVaultStore.getState().error).toBeNull();
  });
});
