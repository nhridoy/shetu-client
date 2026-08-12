import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/db", () => ({
  listRows: vi.fn(),
  upsertRow: vi.fn(),
  deleteRow: vi.fn(),
}));
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "u1", email: "a@b.c" } }),
  },
}));

import { deleteRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "./vaultStore";

const mockList = vi.mocked(listRows);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);

const vaultRow = (overrides: Record<string, unknown> = {}) => ({
  id: "v1",
  revision: 1,
  vault_id: "",
  created_at: 1700000000000,
  updated_at: 1700000000000,
  deleted_at: null,
  name: "Personal",
  owner_id: "u1",
  kind: "team",
  sort_order: 0,
  is_default: 0,
  data: "enc",
  ...overrides,
});

beforeEach(() => {
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
        created_at: 1700000001000,
        updated_at: 1700000001000,
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

  it("fetchVaults with no local vaults leaves vaults empty and no selection", async () => {
    mockList.mockResolvedValue([]);

    await useVaultStore.getState().fetchVaults();

    expect(mockUpsert).not.toHaveBeenCalled();
    const { vaults, currentVaultId } = useVaultStore.getState();
    expect(vaults).toHaveLength(0);
    expect(currentVaultId).toBeNull();
  });

  it("fetchVaults does not create vaults, only reads local rows", async () => {
    mockList.mockResolvedValue([vaultRow()]);

    await useVaultStore.getState().fetchVaults();

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(useVaultStore.getState().vaults).toHaveLength(1);
  });

  it("app-created personal vaults with is_default=0 are not default/protected", async () => {
    mockList.mockResolvedValue([
      vaultRow({ id: "old-1", kind: "personal", name: "Old" }),
      vaultRow({ id: "old-2", kind: "personal", name: "Older" }),
    ]);

    await useVaultStore.getState().fetchVaults();

    expect(mockUpsert).not.toHaveBeenCalled();
    const { vaults } = useVaultStore.getState();
    expect(vaults).toHaveLength(2);
    expect(vaults.every((v) => !v.isSystem && !v.isDefault)).toBe(true);
    expect(vaults[0].kind).toBe("personal");
  });

  it("createVault upserts locally, appends and switches to the new vault", async () => {
    mockList.mockResolvedValue([vaultRow()]);
    await useVaultStore.getState().fetchVaults();

    mockUpsert.mockResolvedValue(
      vaultRow({ id: "new", name: "Production", created_at: 1700000002000 }),
    );

    await useVaultStore
      .getState()
      .createVault("Production", "team", "prod cluster");

    expect(mockUpsert).toHaveBeenCalledWith(
      "vaults",
      expect.objectContaining({
        owner_id: "u1",
        kind: "team",
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

  it("switchVault sets currentVaultId", async () => {
    await useVaultStore.getState().switchVault("v2");
    expect(useVaultStore.getState().currentVaultId).toBe("v2");
  });

  it("updateVault upserts changes and replaces the item in state", async () => {
    mockList.mockResolvedValue([vaultRow()]);
    await useVaultStore.getState().fetchVaults();

    mockUpsert.mockResolvedValue(
      vaultRow({ name: "Renamed", updated_at: 1700000003000 }),
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
        created_at: 1700000001000,
        updated_at: 1700000001000,
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

  it("clearError resets the error field", () => {
    useVaultStore.setState({ error: "boom" });
    useVaultStore.getState().clearError();
    expect(useVaultStore.getState().error).toBeNull();
  });
});
