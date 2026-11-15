import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../../lib/db/db");
vi.mock("../../lib/crypto/crypto");
vi.mock("../../lib/common/device", () => ({ getDeviceId: async () => "d1" }));
vi.mock("../auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1", email: "a@b.c" } }) },
}));

import { decryptRowData } from "../../lib/crypto/crypto";
import { deleteRow, listRows } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useIdentityStore } from "./identityStore";

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

const saveCalls = () =>
  h.invoke.mock.calls.filter(([cmd]) => cmd === "identity_save");

beforeEach(() => {
  useIdentityStore.setState({ identities: [], isLoading: false, error: null });
  vi.clearAllMocks();
  useVaultStore.setState({ currentVaultId: "v1" });
  h.invoke.mockImplementation(async (cmd: string, args: { name?: string }) =>
    cmd === "identity_save" ? { ...row, name: args.name } : null,
  );
});

describe("identityStore", () => {
  it("lists labels without decrypting or holding secrets", async () => {
    vi.mocked(listRows).mockResolvedValue([row]);
    await useIdentityStore.getState().fetchIdentities("v1");
    expect(listRows).toHaveBeenCalledWith("identities", "v1");
    expect(decryptRowData).not.toHaveBeenCalled();
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

  it("an older vault's fetch can't overwrite a newer one", async () => {
    let finishOld: (rows: unknown[]) => void = () => {};
    vi.mocked(listRows)
      .mockImplementationOnce(
        () => new Promise((r) => (finishOld = r as never)) as never,
      )
      .mockResolvedValueOnce([{ ...row, id: "new", vault_id: "v2" }]);
    const old = useIdentityStore.getState().fetchIdentities("v1");
    await useIdentityStore.getState().fetchIdentities("v2");
    finishOld([row]);
    await old;
    expect(useIdentityStore.getState().identities.map((i) => i.id)).toEqual([
      "new",
    ]);
  });

  it("create hands the secrets to Rust and keeps none in state", async () => {
    const id = await useIdentityStore.getState().createIdentity({
      name: "deploy@prod",
      username: "deploy",
      password: "pw",
      totpSecret: "GEZDGNBV",
    });
    expect(id).toBe("i1");
    expect(saveCalls()[0][1]).toEqual({
      id: null,
      vaultId: "v1",
      name: "deploy@prod",
      patch: { username: "deploy", password: "pw", totpSecret: "GEZDGNBV" },
      deviceId: "d1",
    });
    expect(
      JSON.stringify(useIdentityStore.getState().identities),
    ).not.toContain("pw");
  });

  it("update sends only the patch; Rust merges it", async () => {
    useIdentityStore.setState({
      identities: [
        { id: "i1", name: "old", vaultId: "v1", sortOrder: 0, createdAt: "1" },
      ],
    });
    expect(
      await useIdentityStore
        .getState()
        .updateIdentity("i1", { username: "ops", password: "", keyId: null }),
    ).toBe(true);
    expect(saveCalls()[0][1]).toMatchObject({
      id: "i1",
      vaultId: "v1",
      name: "old",
      patch: { username: "ops", password: "", keyId: null },
    });
  });

  it("updates of one identity run one after another", async () => {
    const order: string[] = [];
    h.invoke.mockImplementation(
      async (_cmd: string, args: { patch: object }) => {
        order.push(`start ${JSON.stringify(args.patch)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end");
        return row;
      },
    );
    const store = useIdentityStore.getState();
    await Promise.all([
      store.updateIdentity("i1", { username: "a" }),
      store.updateIdentity("i1", { keyId: "k2" }),
    ]);
    expect(order).toEqual([
      'start {"username":"a"}',
      "end",
      'start {"keyId":"k2"}',
      "end",
    ]);
  });

  it("the edit view comes from Rust without secrets", async () => {
    const view = {
      username: "deploy",
      keyId: "k1",
      hasPassword: true,
      hasTotp: true,
    };
    h.invoke.mockResolvedValue(view);
    expect(
      await useIdentityStore.getState().getDecryptedIdentity("i1"),
    ).toEqual(view);
    expect(h.invoke).toHaveBeenCalledWith("identity_view", { id: "i1" });
    expect(decryptRowData).not.toHaveBeenCalled();
  });

  it("a failed save reports the error", async () => {
    h.invoke.mockRejectedValue("Username is required");
    expect(
      await useIdentityStore.getState().updateIdentity("i1", { username: "" }),
    ).toBe(false);
    expect(useIdentityStore.getState().error).toBe("Username is required");
  });

  it("delete tombstones the row and drops it from the list", async () => {
    useIdentityStore.setState({
      identities: [
        { id: "i1", name: "x", vaultId: "v1", sortOrder: 0, createdAt: "1" },
      ],
    });
    await useIdentityStore.getState().deleteIdentity("i1");
    expect(deleteRow).toHaveBeenCalledWith("identities", "i1");
    expect(useIdentityStore.getState().identities).toEqual([]);
  });
});
