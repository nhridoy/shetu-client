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
import { useKeyStore } from "./keyStore";

const mockList = vi.mocked(listRows);
const mockGet = vi.mocked(getRow);
const mockUpsert = vi.mocked(upsertRow);
const mockDelete = vi.mocked(deleteRow);
const mockDecrypt = vi.mocked(decryptRowData);

const keyRow = {
  id: "k1",
  revision: 1,
  vault_id: "v1",
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  name: "prod",
  description: "prod key",
  sort_order: 0,
  data: "enc",
};

beforeEach(() => {
  useKeyStore.setState({
    keys: [],
    selectedKey: null,
    isLoading: false,
    error: null,
  });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("keyStore", () => {
  it("fetchKeys reads plaintext columns without decrypting", async () => {
    mockList.mockResolvedValue([
      {
        ...keyRow,
        key_type: "ed25519",
        fingerprint: "fp",
        public_key: "pub",
      },
    ]);
    await useKeyStore.getState().fetchKeys("v1");
    expect(mockList).toHaveBeenCalledWith("keys", "v1");
    expect(mockDecrypt).not.toHaveBeenCalled();
    const key = useKeyStore.getState().keys[0];
    expect(key.id).toBe("k1");
    expect(key.name).toBe("prod");
    expect(key.description).toBe("prod key");
    expect(key.keyType).toBe("ed25519");
    expect(key.publicKey).toBe("pub");
    expect(key.encryptedPrivateKey).toBe("");
    expect(key.fingerprint).toBe("fp");
    expect(key.createdAt).toBe("1000");
    expect(key.data).toBe("enc");
  });

  it("getDecryptedKey decrypts on demand from state, no db_get", async () => {
    mockList.mockResolvedValue([
      {
        ...keyRow,
        key_type: "ed25519",
        fingerprint: "fp",
        public_key: "pub",
      },
    ]);
    await useKeyStore.getState().fetchKeys("v1");
    mockDecrypt.mockResolvedValue({
      privateKey: "PRIV",
      passphrase: undefined,
    });
    const key = await useKeyStore.getState().getDecryptedKey("k1");
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDecrypt).toHaveBeenCalledWith("enc");
    expect(key?.encryptedPrivateKey).toBe("PRIV");
    expect(key?.publicKey).toBe("pub");
  });

  it("getDecryptedKey falls back to db_get when not in state", async () => {
    mockGet.mockResolvedValue({
      ...keyRow,
      key_type: "ed25519",
      fingerprint: "fp",
      public_key: "pub",
    });
    mockDecrypt.mockResolvedValue({
      privateKey: "PRIV",
      passphrase: undefined,
    });
    const key = await useKeyStore.getState().getDecryptedKey("k1");
    expect(mockGet).toHaveBeenCalledWith("keys", "k1");
    expect(key?.encryptedPrivateKey).toBe("PRIV");
  });

  it("importKey falls back to crypto.randomUUID, passes plaintext payload, upserts with vault fallback", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    mockUpsert.mockResolvedValue({
      id: "123e4567-e89b-12d3-a456-426614174000",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useKeyStore.getState().importKey({
      name: "mykey",
      publicKey: "pub",
      encryptedPrivateKey: "PRIV",
    });
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      privateKey: "PRIV",
    });
    expect(opts.recordType).toBe("keys");
    expect(mockUpsert).toHaveBeenCalledWith(
      "keys",
      expect.objectContaining({
        id: "123e4567-e89b-12d3-a456-426614174000",
        vault_id: "v1",
        name: "mykey",
        key_type: "ed25519",
        public_key: "pub",
      }),
      expect.objectContaining({ recordType: "keys" }),
    );
    expect(useKeyStore.getState().keys.length).toBe(1);
  });

  it("importKey keeps sensitive key material out of plaintext columns", async () => {
    mockUpsert.mockResolvedValue({
      id: "123e4567-e89b-12d3-a456-426614174000",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useKeyStore.getState().importKey({
      name: "mykey",
      keyType: "rsa",
      publicKey: "pub",
      encryptedPrivateKey: "PRIV",
      fingerprint: "fp",
    });
    const rowArg = mockUpsert.mock.calls[0][1];
    expect(rowArg).not.toHaveProperty("privateKey");
    expect(rowArg).not.toHaveProperty("encryptedPrivateKey");
    expect(rowArg).not.toHaveProperty("passphrase");
    expect(rowArg).toHaveProperty("key_type", "rsa");
    expect(rowArg).toHaveProperty("public_key", "pub");
    expect(rowArg).toHaveProperty("fingerprint", "fp");
    expect(mockUpsert).toHaveBeenCalledWith(
      "keys",
      expect.not.objectContaining({
        name: "PRIV",
        description: "PRIV",
        sort_order: "PRIV",
      }),
      expect.objectContaining({ recordType: "keys" }),
    );
  });

  it("generateKey passes empty key material plaintext and upserts", async () => {
    mockUpsert.mockResolvedValue({
      id: "123e4567-e89b-12d3-a456-426614174000",
      revision: 1,
      vault_id: "v1",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
      sort_order: 0,
      data: "enc",
    });
    useVaultStore.setState({ currentVaultId: "v1" });
    await useKeyStore.getState().generateKey("gen-key", "ed25519");
    const opts = mockUpsert.mock.calls[0][2] as {
      plaintext: string;
      recordType: string;
    };
    expect(JSON.parse(opts.plaintext)).toMatchObject({
      privateKey: "",
    });
    expect(opts.recordType).toBe("keys");
    expect(mockUpsert).toHaveBeenCalledWith(
      "keys",
      expect.objectContaining({
        name: "gen-key",
        vault_id: "v1",
        key_type: "ed25519",
      }),
      expect.objectContaining({ recordType: "keys" }),
    );
    expect(useKeyStore.getState().keys.length).toBe(1);
  });

  it("deleteKey tombstones and clears selection", async () => {
    useKeyStore.setState({
      keys: [
        {
          id: "k1",
          name: "x",
          keyType: "ed25519",
          publicKey: "",
          encryptedPrivateKey: "",
          createdAt: "",
        },
      ],
      selectedKey: {
        id: "k1",
        name: "x",
        keyType: "ed25519",
        publicKey: "",
        encryptedPrivateKey: "",
        createdAt: "",
      },
    });
    await useKeyStore.getState().deleteKey("k1");
    expect(mockDelete).toHaveBeenCalledWith("keys", "k1");
    expect(useKeyStore.getState().keys).toEqual([]);
    expect(useKeyStore.getState().selectedKey).toBeNull();
  });

  it("getCredentialsForKey decrypts from state, no db_get", async () => {
    mockList.mockResolvedValue([
      {
        ...keyRow,
        key_type: "ed25519",
        fingerprint: "fp",
        public_key: "pub",
      },
    ]);
    await useKeyStore.getState().fetchKeys("v1");
    mockDecrypt.mockResolvedValue({
      keyType: "ed25519",
      publicKey: "pub",
      privateKey: "PRIV",
      fingerprint: "fp",
    });
    const creds = await useKeyStore.getState().getCredentialsForKey("k1");
    expect(mockGet).not.toHaveBeenCalled();
    expect(creds).toBe("PRIV");
  });

  it("getCredentialsForKey returns empty string for missing key", async () => {
    mockGet.mockResolvedValue(null);
    const creds = await useKeyStore.getState().getCredentialsForKey("missing");
    expect(creds).toBe("");
  });
});
