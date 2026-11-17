import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/terminal/sessionRestore", () => ({
  endAllSessions: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  })),
}));
vi.mock("@/lib/api/auth", () => ({
  authApi: {
    accountStatus: vi.fn(),
    prelogin: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    me: vi.fn(),
    fetchKeyring: vi.fn(),
    fetchDefaultVault: vi.fn(),
    attachRecoveryMaterial: vi.fn(),
    requestAccountDeletion: vi.fn(),
    cancelAccountDeletion: vi.fn(),
    recoveryPrefetch: vi.fn(),
    recovery: vi.fn(),
  },
  loadApiUrl: vi.fn(async () => {}),
  getApiUrl: vi.fn(() => "http://localhost:8080"),
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public status: number,
      public apiError: { code: string; message: string; challenge?: string },
    ) {
      super(apiError.message);
    }
  },
}));
vi.mock("../../lib/oauth/oauth", () => ({
  startOAuthFlow: vi.fn(),
  cancelOAuthFlow: vi.fn(),
}));
vi.mock("@/lib/account/resetDevice", () => ({ resetDevice: vi.fn() }));
vi.mock("../../lib/api/http", () => ({ onSessionRevoked: vi.fn() }));
vi.mock("../../lib/crypto/crypto", () => ({
  deriveKek: vi.fn(async () => {}),
  computeLoginProof: vi.fn(async () => ({ proof: "proof", verifier: "v" })),
  unwrapDek: vi.fn(async () => {}),
  lockSession: vi.fn(async () => {}),
  clearKeychain: vi.fn(async () => {}),
  setRefreshToken: vi.fn(),
  saveRefreshToken: vi.fn(async () => {}),
  loadRefreshToken: vi.fn(async () => null),
  setBaseUrl: vi.fn(async () => {}),
  setAuthTokens: vi.fn(async () => {}),
  clearAuthTokens: vi.fn(async () => {}),
  clearAccessToken: vi.fn(async () => {}),
  recoveryUnwrapDek: vi.fn(async () => {}),
  unwrapPrivateKey: vi.fn(async () => {}),
  generateRecoveryCode: vi.fn(async () => "new-code"),
  signChallenge: vi.fn(async () => "sig"),
  buildKeyringRows: vi.fn(async () => ({
    dek_wrapped_by_kek: "kek",
    dek_wrapped_by_recovery: "rec",
    private_key_wrapped_by_dek: "pk",
  })),
}));
vi.mock("../../lib/crypto/offlineIdentity", () => ({
  loadOfflineIdentity: vi.fn(async () => null),
  saveOfflineIdentity: vi.fn(async () => {}),
}));
vi.mock("../../lib/db/db", () => ({ wipeLocalData: vi.fn(async () => {}) }));
vi.mock("../../lib/keychain/keychain", () => ({
  deletePassword: vi.fn(async () => {}),
  loadPassword: vi.fn(async () => null),
  savePassword: vi.fn(async () => {}),
}));
vi.mock("../../lib/common/device", () => ({
  getDeviceId: vi.fn(async () => "dev-1"),
}));

vi.mock("@/lib/api/twoFactor", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/twoFactor")>()),
  twoFactorApi: { verify: vi.fn(), sendEmailCode: vi.fn() },
}));

import { AuthApiError, authApi } from "@/lib/api/auth";
import { twoFactorApi } from "@/lib/api/twoFactor";
import { setAuthTokens } from "../../lib/crypto/crypto";
import { startOAuthFlow } from "../../lib/oauth/oauth";
import { useAuthStore } from "./authStore";

const user = {
  id: "u1",
  email: "a@example.com",
  initialized: true,
  auth_provider: "password",
  created_at: "2026-01-01",
};
const keyring = {
  dek_wrapped_by_kek: "kek",
  dek_wrapped_by_recovery: "rec",
  private_key_wrapped_by_dek: "pk",
};
const required = () =>
  new AuthApiError(401, {
    code: "TWO_FACTOR_REQUIRED",
    message: "Enter your two-factor code.",
    challenge: "ch",
  });
const apiError = (code: string, message: string) =>
  new AuthApiError(401, { code, message });
const signedIn = { access_token: "a", refresh_token: "r", user, keyring };

async function loginToCodeScreen() {
  vi.mocked(authApi.login).mockRejectedValueOnce(required());
  const signIn = useAuthStore.getState().login("a@example.com", "pw");
  await vi.waitFor(() =>
    expect(useAuthStore.getState().pendingTwoFactor).toEqual({
      path: "login",
      challenge: "ch",
    }),
  );
  // Wrapped: an async function returning the promise would wait for it to settle.
  return { signIn };
}

describe("two-factor sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      serverAuthenticated: false,
      isUnlocked: false,
      localAccessAccountId: null,
      deletionNotice: null,
      pendingDeletion: null,
      pendingTwoFactor: null,
      pendingRecoveryCode: null,
      error: null,
      isLoading: false,
    });
  });

  it("login waits for the code and finishes with the verified response", async () => {
    const { signIn } = await loginToCodeScreen();
    expect(useAuthStore.getState().isLoading).toBe(false);
    vi.mocked(twoFactorApi.verify).mockResolvedValue(signedIn as never);
    await useAuthStore.getState().submitTwoFactor("123456", "totp");
    await signIn;
    expect(twoFactorApi.verify).toHaveBeenCalledWith("ch", "123456", "totp");
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.pendingTwoFactor).toBeNull();
  });

  it("a wrong code keeps the screen", async () => {
    const { signIn } = await loginToCodeScreen();
    vi.mocked(twoFactorApi.verify).mockRejectedValue(
      apiError("TWO_FACTOR_INVALID", "That code isn't right."),
    );
    await expect(
      useAuthStore.getState().submitTwoFactor("000000", "totp"),
    ).rejects.toThrow("That code isn't right.");
    expect(useAuthStore.getState().pendingTwoFactor?.challenge).toBe("ch");
    useAuthStore.getState().cancelTwoFactor();
    await signIn.catch(() => {});
  });

  it("an expired challenge ends the sign-in", async () => {
    const { signIn } = await loginToCodeScreen();
    vi.mocked(twoFactorApi.verify).mockRejectedValue(
      apiError("TWO_FACTOR_EXPIRED", "Start signing in again."),
    );
    await useAuthStore.getState().submitTwoFactor("123456", "totp");
    await expect(signIn).rejects.toThrow("Start signing in again.");
    const s = useAuthStore.getState();
    expect(s.pendingTwoFactor).toBeNull();
    expect(s.error).toBe("Start signing in again.");
    expect(s.isLoading).toBe(false);
  });

  it("cancel returns to the form", async () => {
    const { signIn } = await loginToCodeScreen();
    let finish!: (v: unknown) => void;
    vi.mocked(twoFactorApi.verify).mockReturnValue(
      new Promise((r) => {
        finish = r;
      }) as never,
    );
    const late = useAuthStore.getState().submitTwoFactor("123456", "totp");
    useAuthStore.getState().cancelTwoFactor();
    await expect(signIn).rejects.toThrow();
    finish(signedIn);
    await late;
    const s = useAuthStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.pendingTwoFactor).toBeNull();
    expect(s.isAuthenticated).toBe(false);
  });

  it("OAuth waits for the code", async () => {
    vi.mocked(startOAuthFlow).mockResolvedValue({
      dest: "two_factor",
      challenge: "ch",
      userId: "u1",
    });
    const flow = useAuthStore.getState().oauthStartFlow("github");
    await vi.waitFor(() =>
      expect(useAuthStore.getState().pendingTwoFactor).toEqual({
        path: "oauth",
        challenge: "ch",
      }),
    );
    vi.mocked(twoFactorApi.verify).mockResolvedValue(signedIn as never);
    await useAuthStore.getState().submitTwoFactor("123456", "totp");
    await flow.catch(() => {});
    expect(setAuthTokens).toHaveBeenCalledWith("a", "r");
  });

  it("recovery passes the proof", async () => {
    vi.mocked(authApi.recoveryPrefetch).mockRejectedValueOnce(required());
    const flow = useAuthStore.getState().recovery("code", "new-password");
    await vi.waitFor(() =>
      expect(useAuthStore.getState().pendingTwoFactor?.path).toBe("recovery"),
    );
    vi.mocked(twoFactorApi.verify).mockResolvedValue({
      nonce: "n",
      email: "a@example.com",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
      dek_wrapped_by_recovery: "rec",
      private_key_wrapped_by_dek: "pk",
      two_factor_proof: "proof-1",
    } as never);
    vi.mocked(authApi.recovery).mockResolvedValue(undefined);
    await useAuthStore.getState().submitTwoFactor("123456", "totp");
    await flow.catch(() => {});
    expect(authApi.recovery).toHaveBeenCalledWith(
      expect.objectContaining({ two_factor_proof: "proof-1" }),
    );
  });

  it("the email code is only offered on recovery", async () => {
    const { signIn } = await loginToCodeScreen();
    await expect(
      useAuthStore.getState().sendTwoFactorEmail(),
    ).rejects.toThrow();
    expect(twoFactorApi.sendEmailCode).not.toHaveBeenCalled();
    useAuthStore.getState().cancelTwoFactor();
    await signIn.catch(() => {});
  });

  it("sign-out during the code screen stops the sign-in", async () => {
    const { signIn } = await loginToCodeScreen();
    await useAuthStore.getState().logout();
    await signIn.catch(() => {});
    const s = useAuthStore.getState();
    expect(s.pendingTwoFactor).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(twoFactorApi.verify).not.toHaveBeenCalled();
  });

  it("a stale first-factor answer never replaces the current code screen", async () => {
    let lateA!: (e: unknown) => void;
    vi.mocked(authApi.login).mockReturnValueOnce(
      new Promise((_, reject) => {
        lateA = reject;
      }) as never,
    );
    const a = useAuthStore.getState().login("a@example.com", "pw");
    await vi.waitFor(() => expect(authApi.login).toHaveBeenCalledTimes(1));
    await useAuthStore.getState().logout();
    vi.mocked(authApi.login).mockRejectedValueOnce(
      new AuthApiError(401, {
        code: "TWO_FACTOR_REQUIRED",
        message: "m",
        challenge: "chB",
      }),
    );
    const b = useAuthStore.getState().login("a@example.com", "pw");
    await vi.waitFor(() =>
      expect(useAuthStore.getState().pendingTwoFactor?.challenge).toBe("chB"),
    );
    lateA(
      new AuthApiError(401, {
        code: "TWO_FACTOR_REQUIRED",
        message: "m",
        challenge: "chA",
      }),
    );
    await a.catch(() => {});
    expect(useAuthStore.getState().pendingTwoFactor?.challenge).toBe("chB");
    useAuthStore.getState().cancelTwoFactor();
    await b.catch(() => {});
  });

  it("a recovery overtaken by another sign-in does not resume", async () => {
    vi.mocked(authApi.recoveryPrefetch).mockRejectedValueOnce(required());
    // Settles while the other sign-in runs: handle it from the start.
    const recovery = useAuthStore
      .getState()
      .recovery("code", "new-password")
      .catch(() => {});
    await vi.waitFor(() =>
      expect(useAuthStore.getState().pendingTwoFactor?.path).toBe("recovery"),
    );
    vi.mocked(authApi.login).mockResolvedValueOnce(signedIn as never);
    await useAuthStore
      .getState()
      .login("a@example.com", "pw")
      .catch(() => {});
    vi.mocked(twoFactorApi.verify).mockResolvedValue({
      two_factor_proof: "p",
    } as never);
    await useAuthStore
      .getState()
      .submitTwoFactor("123456", "totp")
      .catch(() => {});
    await recovery;
    expect(authApi.recovery).not.toHaveBeenCalled();
    expect(useAuthStore.getState().pendingRecoveryCode).toBeNull();
  });
});
