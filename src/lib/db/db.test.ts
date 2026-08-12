import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { deleteRow, getOutbox, getRow, listRows, upsertRow } from "./db";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("db wrapper", () => {
  it("listRows maps invoke args", async () => {
    mockInvoke.mockResolvedValue([{ id: "h1", revision: 1, vault_id: "v1" }]);
    const rows = await listRows("hosts", "v1");
    expect(mockInvoke).toHaveBeenCalledWith("db_list", {
      table: "hosts",
      vaultId: "v1",
      includeDeleted: false,
    });
    expect(rows[0].id).toBe("h1");
  });

  it("getRow returns null when absent", async () => {
    mockInvoke.mockResolvedValue(null);
    expect(await getRow("keys", "k1")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("db_get", {
      table: "keys",
      id: "k1",
    });
  });

  it("upsertRow passes row object with null plaintext args", async () => {
    const row = { id: "h1", vault_id: "v1", data: "enc", name: "prod" };
    mockInvoke.mockResolvedValue({ ...row, revision: 2 });
    const saved = await upsertRow("hosts", row);
    expect(mockInvoke).toHaveBeenCalledWith("db_upsert", {
      table: "hosts",
      row,
      plaintext: undefined,
      recordType: undefined,
    });
    expect(saved.revision).toBe(2);
  });

  it("upsertRow forwards plaintext and recordType opts", async () => {
    const row = { id: "h2", vault_id: "v1", name: "prod" };
    mockInvoke.mockResolvedValue({ ...row, data: "enc", revision: 1 });
    await upsertRow("hosts", row, {
      plaintext: '{"address":"1.2.3.4"}',
      recordType: "hosts",
    });
    expect(mockInvoke).toHaveBeenCalledWith("db_upsert", {
      table: "hosts",
      row,
      plaintext: '{"address":"1.2.3.4"}',
      recordType: "hosts",
    });
  });

  it("deleteRow tombstones via db_delete", async () => {
    mockInvoke.mockResolvedValue(null);
    await deleteRow("snippets", "s1");
    expect(mockInvoke).toHaveBeenCalledWith("db_delete", {
      table: "snippets",
      id: "s1",
    });
  });

  it("getOutbox returns entries", async () => {
    mockInvoke.mockResolvedValue([
      { table_name: "hosts", record_id: "h1", queued_at: 1 },
    ]);
    const out = await getOutbox();
    expect(out[0].record_id).toBe("h1");
  });

  it("vaults use the generic row commands", async () => {
    mockInvoke.mockResolvedValue([
      {
        id: "v1",
        revision: 1,
        vault_id: "",
        created_at: 1700000000000,
        updated_at: 1700000000000,
        deleted_at: null,
        name: "Personal",
        owner_id: "u1",
        kind: "personal",
        sort_order: 0,
        data: "enc",
      },
    ]);
    const rows = await listRows("vaults", "");
    expect(mockInvoke).toHaveBeenCalledWith("db_list", {
      table: "vaults",
      vaultId: "",
      includeDeleted: false,
    });
    expect(rows[0].kind).toBe("personal");

    mockInvoke.mockClear();
    await upsertRow("vaults", {
      id: "v1",
      vault_id: "",
      name: "Personal",
      owner_id: "u1",
      kind: "personal",
      sort_order: 0,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "db_upsert",
      expect.objectContaining({ table: "vaults" }),
    );

    mockInvoke.mockClear();
    await deleteRow("vaults", "v1");
    expect(mockInvoke).toHaveBeenCalledWith("db_delete", {
      table: "vaults",
      id: "v1",
    });
  });
});
