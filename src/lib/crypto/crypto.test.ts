import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKeyringRows,
  clearAuthTokens,
  computeLoginProof,
  decryptObject,
  decryptRowData,
  decryptSecret,
  deriveKek,
  encryptObject,
  encryptRowData,
  encryptSecret,
  generateAccountMaterial,
  generateRecoveryCode,
  getCurrentUserId,
  getStoredSalt,
  isEncrypted,
  lockSession,
  recoveryUnwrapDek,
  setAuthTokens,
  setBaseUrl,
  setCurrentUser,
  signChallenge,
  unlock,
  unwrapDek,
  unwrapPrivateKey,
} from "./crypto";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentUser(null);
});

describe("setCurrentUser / getCurrentUserId", () => {
  it("starts with null", () => {
    expect(getCurrentUserId()).toBeNull();
  });

  it("stores the user id", () => {
    setCurrentUser("user-123");
    expect(getCurrentUserId()).toBe("user-123");
  });

  it("clears on null", () => {
    setCurrentUser("user-123");
    setCurrentUser(null);
    expect(getCurrentUserId()).toBeNull();
  });
});

describe("getStoredSalt", () => {
  it("returns null (salt is in Rust session)", () => {
    expect(getStoredSalt("user-123")).toBeNull();
  });
});

describe("isEncrypted", () => {
  it("returns false for non-strings", () => {
    expect(isEncrypted(42)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted({})).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    expect(isEncrypted("not json")).toBe(false);
  });

  it("returns false for missing fields", () => {
    expect(isEncrypted('{"v":1}')).toBe(false);
    expect(isEncrypted('{"alg":"xchacha20poly1305"}')).toBe(false);
  });

  it("returns false for wrong version", () => {
    expect(
      isEncrypted('{"v":2,"alg":"xchacha20poly1305","nonce":"abc","ct":"def"}'),
    ).toBe(false);
  });

  it("recognizes contextual team ciphertext only when its binding fields are present", () => {
    expect(
      isEncrypted(
        JSON.stringify({
          v: 2,
          alg: "xchacha20poly1305",
          nonce: "abc",
          ct: "def",
          record_type: "hosts",
          vault_id: "vault",
          epoch: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isEncrypted(
        JSON.stringify({
          v: 2,
          alg: "xchacha20poly1305",
          nonce: "abc",
          ct: "def",
          record_type: "hosts",
          vault_id: "vault",
        }),
      ),
    ).toBe(false);
  });

  it("returns true for valid encrypted payload", () => {
    const payload = JSON.stringify({
      v: 1,
      alg: "xchacha20poly1305",
      nonce: "abc",
      ct: "def",
    });
    expect(isEncrypted(payload)).toBe(true);
  });
});

describe("generateAccountMaterial", () => {
  it("returns salt_cl, recovery_code, public_key", async () => {
    const material = {
      salt_cl: "abc123",
      recovery_code: "def456",
      public_key: "ghi789",
      private_key_wrapped_by_dek: "wrapped-key",
    };
    mockInvoke.mockResolvedValue(material);

    const result = await generateAccountMaterial();

    expect(mockInvoke).toHaveBeenCalledWith("generate_account_material");
    expect(result.salt_cl).toBe("abc123");
    expect(result.recovery_code).toBe("def456");
    expect(result.public_key).toBe("ghi789");
    expect(result.private_key_wrapped_by_dek).toBe("wrapped-key");
  });
});

describe("deriveKek", () => {
  it("calls invoke with password and saltCl", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await deriveKek("mypass", "salt-b64");

    expect(mockInvoke).toHaveBeenCalledWith("derive_kek", {
      password: "mypass",
      saltCl: "salt-b64",
    });
  });
});

describe("encryptSecret / decryptSecret roundtrip", () => {
  it("encrypts then decrypts", async () => {
    const ciphertext =
      '{"v":1,"alg":"xchacha20poly1305","nonce":"abc","ct":"def"}';
    mockInvoke
      .mockResolvedValueOnce(ciphertext)
      .mockResolvedValueOnce("hello world");

    const encrypted = await encryptSecret("hello world", "host");
    expect(encrypted).toBe(ciphertext);
    expect(mockInvoke).toHaveBeenCalledWith("encrypt_secret", {
      plaintext: "hello world",
      recordType: "host",
    });

    const decrypted = await decryptSecret(ciphertext);
    expect(decrypted).toBe("hello world");
    expect(mockInvoke).toHaveBeenCalledWith("decrypt_secret", {
      payload: ciphertext,
    });
  });
});

describe("encryptObject", () => {
  it("encrypts specified fields", async () => {
    mockInvoke.mockResolvedValue("encrypted-val");

    const obj = { name: "test", password: "secret", port: 22 };
    const result = await encryptObject(obj, ["password"]);

    expect(result.name).toBe("test");
    expect(result.password).toBe("encrypted-val");
    expect(result.port).toBe(22);
    expect(mockInvoke).toHaveBeenCalledWith("encrypt_secret", {
      plaintext: "secret",
      recordType: "password",
    });
  });

  it("skips non-string fields", async () => {
    const obj = { port: 22, name: "test" };
    await encryptObject(obj, ["port", "name"]);

    expect(mockInvoke).not.toHaveBeenCalledWith("encrypt_secret", {
      plaintext: 22,
      recordType: "port",
    });
  });
});

describe("decryptObject", () => {
  it("decrypts specified fields", async () => {
    mockInvoke.mockResolvedValue("decrypted-val");

    const obj = {
      name: "test",
      password: '{"v":1,"alg":"xchacha20poly1305","nonce":"x","ct":"y"}',
    };
    const result = await decryptObject(obj, ["password"]);

    expect(result.password).toBe("decrypted-val");
  });
});

describe("computeLoginProof", () => {
  it("calls invoke with serverSalt, nonce", async () => {
    const proof = { verifier: "ver", proof: "prf" };
    mockInvoke.mockResolvedValue(proof);

    const result = await computeLoginProof("salt-b64", "nonce-b64");

    expect(result).toEqual(proof);
    expect(mockInvoke).toHaveBeenCalledWith("compute_login_proof", {
      serverSalt: "salt-b64",
      nonce: "nonce-b64",
    });
  });
});

describe("generateRecoveryCode", () => {
  it("calls invoke", async () => {
    mockInvoke.mockResolvedValue("new-code-b64");

    const result = await generateRecoveryCode();

    expect(result).toBe("new-code-b64");
    expect(mockInvoke).toHaveBeenCalledWith("generate_recovery_code");
  });
});

describe("buildKeyringRows", () => {
  it("calls invoke with recoveryCode", async () => {
    const rows = {
      dek_wrapped_by_kek: "a",
      dek_wrapped_by_recovery: "b",
      private_key_wrapped_by_dek: "c",
    };
    mockInvoke.mockResolvedValue(rows);

    const result = await buildKeyringRows("recovery-b64");

    expect(result).toEqual(rows);
    expect(mockInvoke).toHaveBeenCalledWith("build_keyring_rows", {
      recoveryCode: "recovery-b64",
    });
  });
});

describe("unwrapDek", () => {
  it("calls invoke with wrapped", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await unwrapDek("wrapped-b64");

    expect(mockInvoke).toHaveBeenCalledWith("unwrap_dek", {
      wrapped: "wrapped-b64",
    });
  });
});

describe("recoveryUnwrapDek", () => {
  it("calls invoke with recoveryCode, saltCl, wrapped", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await recoveryUnwrapDek("rec-b64", "salt-b64", "wrapped-b64");

    expect(mockInvoke).toHaveBeenCalledWith("recovery_unwrap_dek", {
      recoveryCode: "rec-b64",
      saltCl: "salt-b64",
      wrapped: "wrapped-b64",
    });
  });
});

describe("unwrapPrivateKey", () => {
  it("invokes the rust command with the wrapped key", async () => {
    mockInvoke.mockResolvedValue(void 0);

    await unwrapPrivateKey("wrapped-priv");

    expect(mockInvoke).toHaveBeenCalledWith("unwrap_private_key", {
      wrapped: "wrapped-priv",
    });
  });
});

describe("signChallenge", () => {
  it("calls invoke with nonce", async () => {
    mockInvoke.mockResolvedValue("sig-b64");

    const result = await signChallenge("nonce-b64");

    expect(result).toBe("sig-b64");
    expect(mockInvoke).toHaveBeenCalledWith("sign_challenge", {
      nonce: "nonce-b64",
    });
  });
});

describe("lockSession", () => {
  it("calls invoke", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await lockSession();

    expect(mockInvoke).toHaveBeenCalledWith("lock_session");
  });
});

describe("token custody handoff", () => {
  it("setBaseUrl forwards the URL to Rust", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await setBaseUrl("http://localhost:8080");

    expect(mockInvoke).toHaveBeenCalledWith("set_base_url", {
      url: "http://localhost:8080",
    });
  });

  it("setAuthTokens forwards the pair to Rust", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await setAuthTokens("at", "rt");

    expect(mockInvoke).toHaveBeenCalledWith("set_auth_tokens", {
      accessToken: "at",
      refreshToken: "rt",
    });
  });

  it("setAuthTokens sends null when no refresh token is provided", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await setAuthTokens("at");

    expect(mockInvoke).toHaveBeenCalledWith("set_auth_tokens", {
      accessToken: "at",
      refreshToken: null,
    });
  });

  it("clearAuthTokens clears the Rust token state", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await clearAuthTokens();

    expect(mockInvoke).toHaveBeenCalledWith("clear_auth_tokens");
  });
});

describe("unlock", () => {
  it("calls invoke with password, saltCl, wrappedDek", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await unlock("pass", "salt", "wrapped");

    expect(mockInvoke).toHaveBeenCalledWith("unlock", {
      password: "pass",
      saltCl: "salt",
      wrappedDek: "wrapped",
    });
  });
});

describe("encryptRowData / decryptRowData", () => {
  it("encryptRowData uses table name as AAD", async () => {
    const secret = "secret";
    mockInvoke.mockResolvedValue(secret);
    const encrypted = await encryptRowData("hosts", { address: "1.2.3.4" });
    expect(mockInvoke).toHaveBeenCalledWith("encrypt_secret", {
      plaintext: JSON.stringify({ address: "1.2.3.4" }),
      recordType: "hosts",
    });
    expect(encrypted).toBe(secret);
  });

  it("decryptRowData parses payload json", async () => {
    mockInvoke.mockResolvedValueOnce('{"port":22}');
    expect(await decryptRowData("enc")).toEqual({ port: 22 });
  });
});
