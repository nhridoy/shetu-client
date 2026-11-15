import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/db");
vi.mock("../../lib/crypto/crypto");
vi.mock("../auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1", email: "a@b.c" } }) },
}));

import { decryptRowData } from "../../lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useIdentityStore } from "./identityStore";

const mockList = vi.mocked(listRows);
const mockGet = vi.mocked(getRow);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);
const mockDecrypt = vi.mocked(decryptRowData);

const row = {
  id: "i1",
  revision: 1,
  vault_id: "v1",
  created_at: "1970-01-01T00:00:01.000Z",
  updated_at: "1970-01-01T00:00:01.000Z",
  deleted_at: null,
  name: "deploy@prod",
  sort_order: 0,
  data: "enc",
};

const stored = {
  username: "deploy",
  password: "pw",
  keyId: "k1",
  totpSecret: "GEZDGNBV",
};

function savedPlaintext(call = 0) {
  return JSON.parse(mockUpsert.mock.calls[call][2]?.plaintext ?? "{}");
}

beforeEach(() => {
  useIdentityStore.setState({ identities: [], isLoading: false, error: null });
  vi.clearAllMocks();
  useVaultStore.setState({ currentVaultId: "v1" });
  mockGet.mockResolvedValue(row);
  mockDecrypt.mockResolvedValue(stored);
  mockUpsert.mockImplementation(async (_t, r) => ({ ...row, ...r }));
});

describe("identityStore", () => {
  it("lists labels without decrypting or holding secrets", async () => {
    mockList.mockResolvedValue([row]);
    await useIdentityStore.getState().fetchIdentities("v1");
    expect(mockList).toHaveBeenCalledWith("identities", "v1");
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(useIdentityStore.getState().identities).toEqual([
      {
        id: "i1",
        name: "deploy@prod",
        vaultId: "v1",
        sortOrder: 0,
        createdAt: row.created_at,
      },
    ]);
  });

  it("create puts secrets only in the encrypted plaintext", async () => {
    const id = await useIdentityStore.getState().createIdentity({
      name: "deploy@prod",
      username: "deploy",
      password: "pw",
      totpSecret: "GEZDGNBV",
    });
    expect(id).toBeTruthy();
    const [table, written, opts] = mockUpsert.mock.calls[0];
    expect(table).toBe("identities");
    expect(written).toMatchObject({ name: "deploy@prod", vault_id: "v1" });
    expect(JSON.stringify(written)).not.toContain("pw");
    expect(opts?.recordType).toBe("identities");
    expect(savedPlaintext()).toEqual({
      username: "deploy",
      password: "pw",
      totpSecret: "GEZDGNBV",
    });
    expect(
      JSON.stringify(useIdentityStore.getState().identities),
    ).not.toContain("pw");
  });

  it("update merges and keeps unpatched fields", async () => {
    expect(
      await useIdentityStore
        .getState()
        .updateIdentity("i1", { username: "ops" }),
    ).toBe(true);
    expect(savedPlaintext()).toEqual({ ...stored, username: "ops" });
  });

  it("an empty password or TOTP on update keeps the stored one; null clears", async () => {
    await useIdentityStore
      .getState()
      .updateIdentity("i1", { password: "", totpSecret: "" });
    expect(savedPlaintext()).toEqual(stored);
    await useIdentityStore
      .getState()
      .updateIdentity("i1", { password: null, totpSecret: null, keyId: null });
    expect(savedPlaintext(1)).toEqual({ username: "deploy" });
  });

  it("updates of one identity run one after another", async () => {
    let current: Record<string, unknown> = { ...stored };
    mockDecrypt.mockImplementation(async () => ({ ...current }));
    mockUpsert.mockImplementation(async (_t, r, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = JSON.parse(opts?.plaintext ?? "{}");
      return { ...row, ...r };
    });
    const store = useIdentityStore.getState();
    await Promise.all([
      store.updateIdentity("i1", { username: "a" }),
      store.updateIdentity("i1", { keyId: "k2" }),
    ]);
    expect(current).toMatchObject({ username: "a", keyId: "k2" });
  });

  it("decrypted view says whether secrets exist without returning them", async () => {
    expect(
      await useIdentityStore.getState().getDecryptedIdentity("i1"),
    ).toEqual({
      username: "deploy",
      keyId: "k1",
      hasPassword: true,
      hasTotp: true,
    });
  });

  it("delete tombstones the row and drops it from the list", async () => {
    useIdentityStore.setState({
      identities: [
        {
          id: "i1",
          name: "x",
          vaultId: "v1",
          sortOrder: 0,
          createdAt: row.created_at,
        },
      ],
    });
    await useIdentityStore.getState().deleteIdentity("i1");
    expect(mockDelete).toHaveBeenCalledWith("identities", "i1");
    expect(useIdentityStore.getState().identities).toEqual([]);
  });
});
