import { beforeEach, describe, expect, it, vi } from "vitest";

const { setRefreshToken, getRefreshToken } = vi.hoisted(() => ({
  setRefreshToken: vi.fn(),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  })),
}));

vi.mock("../../lib/api/auth", () => ({
  authApi: {
    register: vi.fn(),
    login: vi.fn(),
    prelogin: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    me: vi.fn(),
    fetchKeyring: vi.fn(),
    attachRecoveryMaterial: vi.fn(),
    recoveryPrefetch: vi.fn(),
    recovery: vi.fn(),
    passwordChange: vi.fn(),
  },
  loadApiUrl: vi.fn(async () => {}),
  getApiUrl: vi.fn(() => "http://localhost:8080"),
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public status: number,
      public apiError: { code: string; message: string; email?: string },
    ) {
      super(apiError.message);
    }
  },
}));

vi.mock("../../lib/api/http", () => ({
  onSessionRevoked: vi.fn(),
}));

vi.mock("../../lib/crypto/crypto", () => ({
  generateAccountMaterial: vi.fn(async () => ({
    recovery_code: "rc",
    public_key: "pk",
    salt_cl: "sc",
  })),
  deriveKek: vi.fn(async () => {}),
  buildKeyringRows: vi.fn(async () => ({
    dek_wrapped_by_kek: "kek",
    dek_wrapped_by_recovery: "rec",
    private_key_wrapped_by_dek: "pk",
  })),
  computeLoginProof: vi.fn(async () => ({
    proof: "proof",
    verifier: "verifier",
  })),
  unwrapDek: vi.fn(async () => {}),
  wrapDek: vi.fn(async () => "new-dek"),
  recoveryUnwrapDek: vi.fn(async () => {}),
  unwrapPrivateKey: vi.fn(async () => {}),
  lockSession: vi.fn(async () => {}),
  clearKeychain: vi.fn(async () => {}),
  setRefreshToken,
  getRefreshToken,
  saveRefreshToken: vi.fn(async () => {}),
  loadRefreshToken: vi.fn(async () => null),
  setBaseUrl: vi.fn(async () => {}),
  setAuthTokens: vi.fn(async () => {}),
  clearAuthTokens: vi.fn(async () => {}),
  signChallenge: vi.fn(async () => "sig"),
  generateRecoveryCode: vi.fn(async () => "new-recovery-code"),
  wrapDekWithRecovery: vi.fn(async () => "wrapped-recovery"),
}));

vi.mock("../../lib/db/db", () => ({
  wipeLocalData: vi.fn(async () => {}),
}));

vi.mock("../../lib/keychain/keychain", () => ({
  deletePassword: vi.fn(async () => {}),
  loadPassword: vi.fn(async () => null),
  savePassword: vi.fn(async () => {}),
}));

vi.mock("../../lib/common/device", () => ({
  getDeviceId: vi.fn(async () => "dev-1"),
}));

import { AuthApiError, authApi } from "../../lib/api/auth";
import { onSessionRevoked } from "../../lib/api/http";
import {
  clearKeychain,
  loadRefreshToken,
  lockSession,
  setAuthTokens,
} from "../../lib/crypto/crypto";
import { wipeLocalData } from "../../lib/db/db";
import { deletePassword, savePassword } from "../../lib/keychain/keychain";
import { useAuthStore } from "./authStore";

// The store registers its session-revoked hook once at import time; capture
// it before beforeEach's vi.clearAllMocks() wipes the mock record.
const registeredRevokedHook = vi.mocked(onSessionRevoked).mock.calls[0]?.[0];

const preloginResponse = {
  nonce: "n",
  kdf: { m: 32768, t: 2, p: 1 },
  server_salt: "ss",
  salt_cl: "sc",
};

const user = {
  id: "u1",
  email: "new@example.com",
  initialized: true,
  auth_provider: "password",
  created_at: "2026-01-01",
};

describe("authStore email verification", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isUnlocked: false,
      pendingVerificationEmail: null,
      pendingRecoveryCode: null,
      pendingRecoveryContext: null,
      error: null,
      isLoading: false,
    });
    vi.clearAllMocks();
  });

  it("register with verification_required sets pending email and no tokens", async () => {
    vi.mocked(authApi.prelogin).mockResolvedValue(preloginResponse);
    vi.mocked(authApi.register).mockResolvedValue({
      user,
      verification_required: true,
    });

    await useAuthStore.getState().register("new@example.com", "New User", "pw");

    const s = useAuthStore.getState();
    expect(s.pendingVerificationEmail).toBe("new@example.com");
    expect(s.isAuthenticated).toBe(false);
    expect(s.tokens).toBeNull();
  });

  it("register omits recovery material and attaches the kit after signup", async () => {
    vi.mocked(authApi.prelogin).mockResolvedValue(preloginResponse);
    vi.mocked(authApi.register).mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      user,
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "",
        private_key_wrapped_by_dek: "pk",
      },
    });
    vi.mocked(authApi.attachRecoveryMaterial).mockResolvedValue({
      recovery_attached: true,
    });

    await useAuthStore.getState().register("new@example.com", "New User", "pw");

    expect(authApi.register).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery_code: "",
        keyring: expect.objectContaining({ dek_wrapped_by_recovery: "" }),
      }),
    );
    expect(authApi.attachRecoveryMaterial).toHaveBeenCalledWith({
      recovery_code: "new-recovery-code",
      dek_wrapped_by_recovery: "wrapped-recovery",
    });
    // the keyring from the register response is reused — no extra fetch
    expect(authApi.fetchKeyring).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.pendingRecoveryCode).toBe("new-recovery-code");
    expect(s.pendingRecoveryContext).toBe("signup");
  });

  it("login with VERIFICATION_REQUIRED sets pending email", async () => {
    vi.mocked(authApi.prelogin).mockResolvedValue(preloginResponse);
    vi.mocked(authApi.login).mockRejectedValue(
      new AuthApiError(403, {
        code: "VERIFICATION_REQUIRED",
        message: "verify your email",
        email: "gate@example.com",
      }),
    );

    await useAuthStore.getState().login("gate@example.com", "pw");

    const s = useAuthStore.getState();
    expect(s.pendingVerificationEmail).toBe("gate@example.com");
    expect(s.isAuthenticated).toBe(false);
  });

  it("login success clears any pending verification email", async () => {
    useAuthStore.setState({ pendingVerificationEmail: "gate@example.com" });
    vi.mocked(authApi.prelogin).mockResolvedValue(preloginResponse);
    vi.mocked(authApi.login).mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      user,
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "rec",
        private_key_wrapped_by_dek: "pk",
      },
    });

    await useAuthStore.getState().login("gate@example.com", "pw");

    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.isUnlocked).toBe(true);
    expect(s.pendingVerificationEmail).toBeNull();
  });

  it("verifyEmail succeeds and authenticates", async () => {
    vi.mocked(authApi.verifyEmail).mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      user,
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "rec",
        private_key_wrapped_by_dek: "pk",
      },
    });

    await useAuthStore
      .getState()
      .verifyEmail("new@example.com", "123456", "pw");

    expect(savePassword).toHaveBeenCalledWith("pw");
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.isUnlocked).toBe(true);
    expect(s.pendingVerificationEmail).toBeNull();
    expect(s.tokens).toEqual({
      access_token: "at",
      refresh_token: "rt",
    });
  });

  it("verifyEmail attaches a recovery kit when the account has none", async () => {
    vi.mocked(authApi.verifyEmail).mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      user,
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "",
        private_key_wrapped_by_dek: "pk",
      },
    });
    vi.mocked(authApi.attachRecoveryMaterial).mockResolvedValue({
      recovery_attached: true,
    });

    await useAuthStore
      .getState()
      .verifyEmail("new@example.com", "123456", "pw");

    expect(authApi.attachRecoveryMaterial).toHaveBeenCalledWith({
      recovery_code: "new-recovery-code",
      dek_wrapped_by_recovery: "wrapped-recovery",
    });
    // the keyring from the verify response is reused — no extra fetch
    expect(authApi.fetchKeyring).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.pendingRecoveryCode).toBe("new-recovery-code");
    expect(s.pendingRecoveryContext).toBe("signup");
    expect(s.pendingVerificationEmail).toBeNull();
  });

  it("verifyEmail does not attach when a recovery kit already exists", async () => {
    vi.mocked(authApi.verifyEmail).mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      user,
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "rec",
        private_key_wrapped_by_dek: "pk",
      },
    });

    await useAuthStore.getState().verifyEmail("new@example.com", "123456");

    expect(authApi.attachRecoveryMaterial).not.toHaveBeenCalled();
    expect(authApi.fetchKeyring).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.pendingRecoveryCode).toBeNull();
    expect(s.pendingRecoveryContext).toBeNull();
  });

  it("ensureRecoveryKit is a no-op without an authenticated session", async () => {
    const code = await useAuthStore.getState().ensureRecoveryKit();
    expect(code).toBeNull();
    expect(authApi.fetchKeyring).not.toHaveBeenCalled();
  });

  it("ensureRecoveryKit survives an attach failure without surfacing an error", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "at", refresh_token: "rt" },
      isAuthenticated: true,
      isUnlocked: true,
    });
    vi.mocked(authApi.fetchKeyring).mockResolvedValue({
      keyring: {
        dek_wrapped_by_kek: "kek",
        dek_wrapped_by_recovery: "",
        private_key_wrapped_by_dek: "pk",
      },
      salt_cl: "sc",
    });
    vi.mocked(authApi.attachRecoveryMaterial).mockRejectedValue(
      new AuthApiError(500, { code: "INTERNAL_ERROR", message: "boom" }),
    );

    const code = await useAuthStore.getState().ensureRecoveryKit();

    expect(code).toBeNull();
    const s = useAuthStore.getState();
    expect(s.error).toBeNull();
  });

  it("verifyEmail failure sets error and rethrows", async () => {
    vi.mocked(authApi.verifyEmail).mockRejectedValue(
      new AuthApiError(400, {
        code: "INVALID_OTP",
        message: "bad otp",
      }),
    );

    await expect(
      useAuthStore.getState().verifyEmail("new@example.com", "000000", "pw"),
    ).rejects.toThrow("bad otp");

    const s = useAuthStore.getState();
    expect(s.error).toBe("bad otp");
    expect(s.isLoading).toBe(false);
    expect(s.pendingVerificationEmail).toBeNull();
  });

  it("logout clears a pending verification session", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "at", refresh_token: "rt" },
      isAuthenticated: true,
      isUnlocked: true,
      pendingVerificationEmail: "new@example.com",
    });

    await useAuthStore.getState().logout();

    expect(authApi.logout).toHaveBeenCalledWith("rt");
    const s = useAuthStore.getState();
    expect(s.pendingVerificationEmail).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isUnlocked).toBe(false);
    expect(s.user).toBeNull();
    expect(s.tokens).toBeNull();
  });

  it("resendVerification calls the API and keeps the pending email", async () => {
    useAuthStore.setState({ pendingVerificationEmail: "new@example.com" });
    vi.mocked(authApi.resendVerification).mockResolvedValue({
      verification_required: true,
    });

    await useAuthStore.getState().resendVerification("new@example.com");

    expect(authApi.resendVerification).toHaveBeenCalledWith("new@example.com");
    const s = useAuthStore.getState();
    expect(s.pendingVerificationEmail).toBe("new@example.com");
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("resendVerification failure sets error and rethrows", async () => {
    useAuthStore.setState({ pendingVerificationEmail: "new@example.com" });
    vi.mocked(authApi.resendVerification).mockRejectedValue(
      new AuthApiError(429, {
        code: "RATE_LIMITED",
        message: "too many requests",
      }),
    );

    await expect(
      useAuthStore.getState().resendVerification("new@example.com"),
    ).rejects.toThrow("too many requests");

    const s = useAuthStore.getState();
    expect(s.error).toBe("too many requests");
    expect(s.isLoading).toBe(false);
    expect(s.pendingVerificationEmail).toBe("new@example.com");
  });

  it("clearPendingVerification resets the pending email", () => {
    useAuthStore.setState({ pendingVerificationEmail: "new@example.com" });

    useAuthStore.getState().clearPendingVerification();

    expect(useAuthStore.getState().pendingVerificationEmail).toBeNull();
  });

  it("logout fully tears down: keychain, refresh token, and local db", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "at", refresh_token: "rt" },
      isAuthenticated: true,
      isUnlocked: true,
    });

    await useAuthStore.getState().logout();

    expect(authApi.logout).toHaveBeenCalledWith("rt");
    expect(lockSession).toHaveBeenCalled();
    expect(deletePassword).toHaveBeenCalled();
    expect(setRefreshToken).toHaveBeenCalledWith(null);
    expect(clearKeychain).toHaveBeenCalled();
    expect(wipeLocalData).toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isUnlocked).toBe(false);
  });

  it("registering the session-revoked hook tears the session down when fired", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "at", refresh_token: "rt" },
      isAuthenticated: true,
      isUnlocked: true,
    });

    const hook = registeredRevokedHook;
    expect(hook).toBeTypeOf("function");

    hook();
    await vi.waitFor(() => {
      const s = useAuthStore.getState();
      expect(s.user).toBeNull();
    });

    expect(lockSession).toHaveBeenCalled();
    expect(deletePassword).toHaveBeenCalled();
    expect(wipeLocalData).toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.tokens).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isUnlocked).toBe(false);
  });

  it("turning alwaysAsk on purges the saved password from the keychain", async () => {
    useAuthStore.setState({ alwaysAsk: false });

    await useAuthStore.getState().setAlwaysAsk(true);

    const s = useAuthStore.getState();
    expect(s.alwaysAsk).toBe(true);
    expect(deletePassword).toHaveBeenCalled();
  });

  it("recovery unwraps the private key before signing with the recovered identity", async () => {
    vi.mocked(authApi.recoveryPrefetch).mockResolvedValue({
      nonce: "recovery-nonce",
      email: "recovered@example.com",
      kdf: { m: 32768, t: 2, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
      dek_wrapped_by_recovery: "wrapped-dek",
      private_key_wrapped_by_dek: "wrapped-priv",
    });
    vi.mocked(authApi.recovery).mockResolvedValue(undefined);

    await useAuthStore.getState().recovery("rc-code", "new-password");

    const { recoveryUnwrapDek, unwrapPrivateKey } = await import(
      "../../lib/crypto/crypto"
    );
    expect(recoveryUnwrapDek).toHaveBeenCalledWith(
      "rc-code",
      "sc",
      "wrapped-dek",
    );
    expect(unwrapPrivateKey).toHaveBeenCalledWith("wrapped-priv");
    expect(vi.mocked(authApi.recovery)).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "sig",
        new_recovery_code: "new-recovery-code",
        new_salt_cl: "sc",
      }),
    );
    const s = useAuthStore.getState();
    expect(s.pendingRecoveryCode).toBe("new-recovery-code");
    expect(s.pendingRecoveryContext).toBe("recovery");
    expect(s.pendingRecoveryEmail).toBe("recovered@example.com");
    expect(s.isLoading).toBe(false);
  });

  it("changePassword keeps the original salt_cl so the recovery kit survives", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "at", refresh_token: "rt" },
      isAuthenticated: true,
    });
    vi.mocked(authApi.prelogin).mockResolvedValue(preloginResponse);
    vi.mocked(authApi.passwordChange).mockResolvedValue(undefined);

    await useAuthStore.getState().changePassword("old-pw", "new-pw");

    expect(authApi.passwordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        new_salt_cl: preloginResponse.salt_cl,
      }),
    );
    const saved = vi.mocked(authApi.passwordChange).mock.calls[0][0] as {
      new_salt_cl: string;
    };
    expect(saved.new_salt_cl).toBe("sc");
  });

  it("restoreSession hands the refreshed pair to Rust and loads the user", async () => {
    vi.mocked(loadRefreshToken).mockResolvedValue("saved-rt");
    vi.mocked(authApi.refresh).mockResolvedValue({
      access_token: "at2",
      refresh_token: "rt2",
    });
    vi.mocked(authApi.me).mockResolvedValue(user);

    await useAuthStore.getState().restoreSession();

    expect(setAuthTokens).toHaveBeenCalledWith("at2", "rt2");
    expect(authApi.me).toHaveBeenCalledWith();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.tokens).toEqual({ access_token: "at2", refresh_token: "rt2" });
    expect(s.user).toEqual(user);
    expect(s.isInitialized).toBe(true);
  });

  it("restoreSession with no saved refresh token stays signed out", async () => {
    vi.mocked(loadRefreshToken).mockResolvedValue(null);
    await useAuthStore.getState().restoreSession();

    expect(authApi.refresh).not.toHaveBeenCalled();
    expect(setAuthTokens).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isInitialized).toBe(true);
  });
});
