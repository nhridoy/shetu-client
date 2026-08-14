import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/db");
vi.mock("../../lib/crypto/crypto");
vi.mock("../auth/authStore", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "u1", email: "a@b.c" } }),
  },
}));
vi.mock("../keys/keyStore", () => ({
  useKeyStore: {
    getState: () => ({ getCredentialsForKey: vi.fn(async () => "PRIVATE") }),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { decryptRowData } from "../../lib/crypto/crypto";
import { deleteRow, getRow, listRows, upsertRow } from "../../lib/db/db";
import { useVaultStore } from "../vault/vaultStore";
import { useHostStore } from "./hostStore";

const mockList = vi.mocked(listRows);
const mockGet = vi.mocked(getRow);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);
const mockDecrypt = vi.mocked(decryptRowData);

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    hosts: [],
    groups: [],
    selectedHost: null,
    isLoading: false,
    error: null,
  });
});

describe("hostStore", () => {
  it("fetchHosts reads plaintext columns without decrypting", async () => {
    mockList.mockResolvedValue([
      {
        id: "h1",
        revision: 1,
        vault_id: "v1",
        created_at: 1000,
        updated_at: 1000,
        deleted_at: null,
        name: "prod",
        os: "linux",
        auth_type: "key",
        tags: '["prod","web"]',
        color: "#f00",
        group_id: "g1",
        key_id: "k1",
        sort_order: 0,
        data: "enc",
      },
    ]);
    await useHostStore.getState().fetchHosts("v1");
    expect(mockList).toHaveBeenCalledWith("hosts", "v1");
    expect(mockDecrypt).not.toHaveBeenCalled();
    const host = useHostStore.getState().hosts[0];
    expect(host.address).toBe("");
    expect(host.port).toBe(22);
    expect(host.username).toBeUndefined();
    expect(host.password).toBeUndefined();
    expect(host.groupId).toBe("g1");
    expect(host.tags).toEqual(["prod", "web"]);
    expect(host.color).toBe("#f00");
    expect(host.os).toBe("linux");
    expect(host.authType).toBe("key");
    expect(host.keyId).toBe("k1");
    expect(host.data).toBe("enc");
  });

  it("getDecryptedHost decrypts on demand from state, no db_get", async () => {
    mockList.mockResolvedValue([
      {
        id: "h1",
        revision: 1,
        vault_id: "v1",
        created_at: 1000,
        updated_at: 1000,
        deleted_at: null,
        name: "prod",
        os: null,
        auth_type: "password",
        tags: "[]",
        color: null,
        group_id: null,
        key_id: null,
        sort_order: 0,
        data: "enc",
      },
    ]);
    await useHostStore.getState().fetchHosts("v1");
    mockDecrypt.mockResolvedValue({
      address: "1.2.3.4",
      port: 2222,
      username: "root",
      password: "pw",
    });
    const host = await useHostStore.getState().getDecryptedHost("h1");
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDecrypt).toHaveBeenCalledWith("enc");
    expect(host?.address).toBe("1.2.3.4");
    expect(host?.port).toBe(2222);
    expect(host?.username).toBe("root");
    expect(host?.password).toBe("pw");
    expect(host?.tags).toEqual([]);
  });

  it("getDecryptedHost falls back to db_get when not in state", async () => {
    mockGet.mockResolvedValue({
      id: "h1",
      revision: 1,
      vault_id: "v1",
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      name: "prod",
      os: null,
      auth_type: "password",
      tags: "[]",
      color: null,
      group_id: null,
      key_id: null,
      sort_order: 0,
      data: "enc",
    });
    mockDecrypt.mockResolvedValue({
      address: "1.2.3.4",
      port: 2222,
      username: "root",
      password: "pw",
    });
    const host = await useHostStore.getState().getDecryptedHost("h1");
    expect(mockGet).toHaveBeenCalledWith("hosts", "h1");
    expect(host?.address).toBe("1.2.3.4");
  });

  it("updateHostOs updates the in-memory host state", async () => {
    useHostStore.setState({
      hosts: [
        {
          id: "h1",
          name: "prod",
          address: "",
          port: 22,
          tags: [],
          sortOrder: 0,
          createdAt: "1",
          updatedAt: "1",
          vaultId: "v1",
          data: "enc",
        },
      ],
    });
    await useHostStore.getState().updateHostOs("h1", "linux");
    expect(useHostStore.getState().hosts[0].os).toBe("linux");
  });

  it("createHost passes plaintext payload with AAD hosts and upserts", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useHostStore
      .getState()
      .createHost({ name: "prod", address: "1.2.3.4", tags: ["web"] });
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      address: "1.2.3.4",
      port: 22,
      username: "root",
    });
    expect(JSON.parse(opts.plaintext)).not.toHaveProperty("authType");
    expect(JSON.parse(opts.plaintext)).not.toHaveProperty("tags");
    expect(opts.recordType).toBe("hosts");
    expect(mockUpsert).toHaveBeenCalledWith(
      "hosts",
      expect.objectContaining({
        name: "prod",
        vault_id: "v1",
        auth_type: "password",
        tags: '["web"]',
      }),
      expect.objectContaining({ recordType: "hosts" }),
    );
    expect(useHostStore.getState().hosts.length).toBe(1);
  });

  it("updateHost preserves unpatched encrypted fields", async () => {
    mockGet.mockResolvedValue({
      id: "h1",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "prod",
      group_id: null,
      key_id: null,
      sort_order: 0,
      data: "enc",
    });
    mockDecrypt.mockResolvedValue({
      address: "1.2.3.4",
      port: 22,
      username: "root",
      authType: "password",
      password: "pw",
      tags: [],
      color: "#64748b",
    });
    await useHostStore.getState().updateHost("h1", { name: "prod2" });
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      address: "1.2.3.4",
      password: "pw",
    });
    expect(opts.recordType).toBe("hosts");
  });

  it("deleteHost tombstones and clears selection", async () => {
    useHostStore.setState({
      hosts: [
        {
          id: "h1",
          name: "x",
          address: "a",
          port: 22,
          tags: [],
          sortOrder: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      selectedHost: {
        id: "h1",
        name: "x",
        address: "a",
        port: 22,
        tags: [],
        sortOrder: 0,
        createdAt: "",
        updatedAt: "",
      },
    });
    await useHostStore.getState().deleteHost("h1");
    expect(mockDelete).toHaveBeenCalledWith("hosts", "h1");
    expect(useHostStore.getState().hosts).toEqual([]);
    expect(useHostStore.getState().selectedHost).toBeNull();
  });

  it("getCredentialsForHost resolves key auth via keyStore", async () => {
    mockGet.mockResolvedValue({
      id: "h1",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "prod",
      auth_type: "key",
      key_id: "k1",
      sort_order: 0,
      data: "enc",
    });
    mockDecrypt.mockResolvedValue({
      address: "1.2.3.4",
      port: 22,
      username: "root",
      password: null,
    });
    const creds = await useHostStore.getState().getCredentialsForHost("h1");
    expect(creds.privateKey).toBe("PRIVATE");
  });

  it("getCredentialsForHost returns password auth creds", async () => {
    mockGet.mockResolvedValue({
      id: "h1",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: "prod",
      auth_type: "password",
      key_id: null,
      sort_order: 0,
      data: "enc",
    });
    mockDecrypt.mockResolvedValue({
      address: "1.2.3.4",
      port: 22,
      username: "root",
      password: "pw",
    });
    const creds = await useHostStore.getState().getCredentialsForHost("h1");
    expect(creds.password).toBe("pw");
    expect(creds.privateKey).toBe("");
  });

  it("fetchGroups decrypts {} payload into Group", async () => {
    mockList.mockResolvedValue([
      {
        id: "g1",
        revision: 1,
        vault_id: "v1",
        created_at: 1000,
        updated_at: 1000,
        deleted_at: null,
        name: "prod",
        sort_order: 0,
        data: "{}",
      },
    ]);
    mockDecrypt.mockResolvedValue({});
    await useHostStore.getState().fetchGroups("v1");
    expect(mockList).toHaveBeenCalledWith("groups", "v1");
    const group = useHostStore.getState().groups[0];
    expect(group.id).toBe("g1");
    expect(group.name).toBe("prod");
  });

  it("createGroup upserts with data encrypted '{}'", async () => {
    mockUpsert.mockResolvedValue({
      id: "new",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      sort_order: 0,
      data: "{}",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useHostStore.getState().createGroup({ name: "prod" });
    expect(mockUpsert).toHaveBeenCalledWith(
      "groups",
      expect.objectContaining({ name: "prod", vault_id: "v1" }),
      { plaintext: "{}", recordType: "groups" },
    );
    expect(useHostStore.getState().groups.length).toBe(1);
  });

  it("deleteGroup tombstones", async () => {
    useHostStore.setState({
      groups: [{ id: "g1", name: "x", sortOrder: 0, createdAt: "" }],
    });
    await useHostStore.getState().deleteGroup("g1");
    expect(mockDelete).toHaveBeenCalledWith("groups", "g1");
    expect(useHostStore.getState().groups).toEqual([]);
  });
});

describe("reorderHost", () => {
  it("swaps sort_order between two hosts", async () => {
    useHostStore.setState({
      hosts: [
        {
          id: "h1",
          name: "a",
          address: "1.1.1.1",
          port: 22,
          tags: [],
          sortOrder: 0,
          createdAt: "",
          updatedAt: "",
          vaultId: "v1",
          data: "enc1",
          authType: "password",
          username: "root",
        },
        {
          id: "h2",
          name: "b",
          address: "2.2.2.2",
          port: 22,
          tags: [],
          sortOrder: 5,
          createdAt: "",
          updatedAt: "",
          vaultId: "v1",
          data: "enc2",
          authType: "password",
          username: "root",
        },
      ],
    });
    mockGet.mockImplementation(async (_table: string, id: string) => ({
      id,
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      name: id === "h1" ? "a" : "b",
      sort_order: id === "h1" ? 0 : 5,
      data: id === "h1" ? "enc1" : "enc2",
    }));
    mockDecrypt.mockImplementation(async (data: string) => ({
      address: data === "enc1" ? "1.1.1.1" : "2.2.2.2",
      port: 22,
      username: "root",
      password: "pw",
    }));
    mockUpsert.mockImplementation(async (_table: string, record: any) => ({
      ...record,
      revision: 2,
      updated_at: 2,
    }));
    await useHostStore.getState().reorderHost("h1", "h2");
    expect(useHostStore.getState().hosts[0]?.sortOrder).toBe(5);
    expect(useHostStore.getState().hosts[1]?.sortOrder).toBe(0);
  });
});

describe("post-save os probe", () => {
  it("createHost fires a background probe and persists the detected os", async () => {
    mockUpsert.mockResolvedValue({
      id: "h1",
      revision: 1,
      vault_id: "v1",
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      name: "x",
      os: null,
      sort_order: 0,
      data: "enc",
      tags: "[]",
    });
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      reachable: true,
      latency_ms: 12,
      os: "ubuntu",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useHostStore
      .getState()
      .createHost({ name: "x", address: "1.2.3.4", port: 22, username: "root", password: "pw" });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ping_host_saved", { hostId: "h1", detectOs: true });
    });
    await vi.waitFor(() => {
      expect(useHostStore.getState().hosts[0]?.os).toBe("ubuntu");
    });
  });

  it("swallows probe failures without setting an error", async () => {
    mockUpsert.mockResolvedValue({
      id: "h2",
      revision: 1,
      vault_id: "v1",
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      name: "y",
      os: null,
      sort_order: 0,
      data: "enc",
      tags: "[]",
    });
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    await useHostStore.getState().createHost({ name: "y", address: "9.9.9.9" });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
    expect(useHostStore.getState().error).toBeNull();
  });

  it("updateHost fires a background probe with the host id", async () => {
    useHostStore.setState({
      hosts: [
        {
          id: "h3",
          name: "old",
          address: "1.2.3.4",
          port: 22,
          username: "root",
          groupId: null,
          tags: [],
          color: "#64748b",
          os: undefined,
          sortOrder: 0,
          createdAt: "1000",
          updatedAt: "1000",
          vaultId: "v1",
          authType: "password",
          data: "old-enc",
        },
      ],
    });
    mockGet.mockResolvedValue({
      id: "h3",
      revision: 1,
      vault_id: "v1",
      created_at: 1000,
      updated_at: 1000,
      deleted_at: null,
      name: "old",
      os: null,
      sort_order: 0,
      data: "old-enc",
      tags: "[]",
    });
    mockDecrypt.mockImplementation(async (data: string) => {
      if (data === "old-enc") {
        return { address: "1.2.3.4", port: 22, username: "root", password: "old-pw" };
      }
      return { address: "10.0.0.5", port: 22, username: "root", password: "new-pw" };
    });
    mockUpsert.mockResolvedValue({
      id: "h3",
      revision: 2,
      vault_id: "v1",
      created_at: 1000,
      updated_at: 2000,
      deleted_at: null,
      name: "old",
      os: null,
      sort_order: 0,
      data: "new-enc",
      tags: "[]",
    });
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      reachable: true,
      latency_ms: 12,
      os: "debian",
    });
    await useHostStore
      .getState()
      .updateHost("h3", { address: "10.0.0.5", password: "new-pw" });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ping_host_saved", { hostId: "h3", detectOs: true });
    });
    await vi.waitFor(() => {
      expect(useHostStore.getState().hosts[0]?.os).toBe("debian");
    });
  });
});
