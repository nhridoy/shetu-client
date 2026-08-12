import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/db");
vi.mock("../../lib/crypto/crypto");
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "u1", email: "a@b.c" } }),
  },
}));

import { decryptRowData } from "../../lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useWorkspaceStore } from "./workspaceStore";

const mockList = vi.mocked(listRows);
const mockGet = vi.mocked(getRow);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);
const mockDecrypt = vi.mocked(decryptRowData);

const workspaceRow = {
  id: "w1",
  revision: 1,
  vault_id: "v1",
  created_at: 1000,
  updated_at: 2000,
  deleted_at: null,
  name: "monitoring",
  sort_order: 0,
  data: "enc",
};

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [],
    isLoading: false,
    error: null,
  });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useVaultStore.setState({ currentVaultId: null });
});

const layout = {
  tabs: [{ root: { type: "leaf", hostId: "h1" } }],
};

describe("workspaceStore", () => {
  it("fetchWorkspaces maps layout string from payload", async () => {
    mockList.mockResolvedValue([workspaceRow]);
    mockDecrypt.mockResolvedValue({
      layout: JSON.stringify(layout),
      hostIds: "h1,h2",
    });
    await useWorkspaceStore.getState().fetchWorkspaces("v1");
    expect(mockList).toHaveBeenCalledWith("workspaces", "v1");
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.id).toBe("w1");
    expect(ws.name).toBe("monitoring");
    expect(ws.layout).toBe(JSON.stringify(layout));
    expect(ws.hostIds).toBe("h1,h2");
    expect(ws.vaultId).toBe("v1");
    expect(ws.createdAt).toBe("1000");
    expect(ws.updatedAt).toBe("2000");
  });

  it("fetchWorkspaces defaults layout to '{}' without payload", async () => {
    mockList.mockResolvedValue([workspaceRow]);
    mockDecrypt.mockResolvedValue({});
    await useWorkspaceStore.getState().fetchWorkspaces("v1");
    expect(useWorkspaceStore.getState().workspaces[0].layout).toBe("{}");
  });

  it("createWorkspace passes stringified layout as plaintext with AAD workspaces and upserts", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "monitoring",
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useWorkspaceStore.getState().createWorkspace("monitoring", layout);
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      layout: JSON.stringify(layout),
    });
    expect(opts.recordType).toBe("workspaces");
    expect(mockUpsert).toHaveBeenCalledWith(
      "workspaces",
      expect.objectContaining({
        name: "monitoring",
        vault_id: "v1",
      }),
      expect.objectContaining({ recordType: "workspaces" }),
    );
    expect(useWorkspaceStore.getState().workspaces.length).toBe(1);
    expect(useWorkspaceStore.getState().workspaces[0].layout).toBe(
      JSON.stringify(layout),
    );
  });

  it("createWorkspace honors explicit vaultId over the current vault", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v2",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "monitoring",
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useWorkspaceStore
      .getState()
      .createWorkspace("monitoring", layout, "v2");
    expect(mockUpsert).toHaveBeenCalledWith(
      "workspaces",
      expect.objectContaining({ vault_id: "v2" }),
      expect.objectContaining({ recordType: "workspaces" }),
    );
  });

  it("createWorkspace keeps layout/hostIds out of plaintext columns and whitelist fields out of the payload", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "monitoring",
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useWorkspaceStore.getState().createWorkspace("monitoring", layout);
    const rowArg = mockUpsert.mock.calls[0][1];
    expect(rowArg).not.toHaveProperty("data");
    expect(rowArg).not.toHaveProperty("layout");
    expect(rowArg).not.toHaveProperty("hostIds");
    const opts = mockUpsert.mock.calls[0][2] as { plaintext: string };
    const payloadArg = JSON.parse(opts.plaintext) as Record<string, unknown>;
    expect(payloadArg).toHaveProperty("layout", JSON.stringify(layout));
    expect(payloadArg).not.toHaveProperty("name");
    expect(payloadArg).not.toHaveProperty("sort_order");
    expect(mockUpsert).toHaveBeenCalledWith(
      "workspaces",
      expect.not.objectContaining({
        name: JSON.stringify(layout),
        sort_order: JSON.stringify(layout),
      }),
      expect.objectContaining({ recordType: "workspaces" }),
    );
  });

  it("renameWorkspace re-encrypts with unchanged layout", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "monitoring",
          layout: JSON.stringify(layout),
          hostIds: "h1",
          createdAt: "1000",
          updatedAt: "2000",
        },
      ],
    });
    mockGet.mockResolvedValue(workspaceRow);
    mockDecrypt.mockResolvedValue({
      layout: JSON.stringify(layout),
      hostIds: "h1",
    });
    await useWorkspaceStore.getState().renameWorkspace("w1", "observability");
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      layout: JSON.stringify(layout),
      hostIds: "h1",
    });
    expect(opts.recordType).toBe("workspaces");
    expect(mockUpsert).toHaveBeenCalledWith(
      "workspaces",
      expect.objectContaining({ name: "observability" }),
      expect.objectContaining({ recordType: "workspaces" }),
    );
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({
      name: "observability",
    });
  });

  it("deleteWorkspace tombstones", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "x",
          layout: "{}",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    await useWorkspaceStore.getState().deleteWorkspace("w1");
    expect(mockDelete).toHaveBeenCalledWith("workspaces", "w1");
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });
});
