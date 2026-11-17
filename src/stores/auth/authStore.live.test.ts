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

vi.mock("@/lib/api/twoFactor_unused", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/twoFactor")>()),
  twoFactorApi: { verify: vi.fn(), sendEmailCode: vi.fn() },
}));

const live = vi.hoisted(() => ({
  signal: null as ((kind: string) => void) | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock("@/lib/live/live", () => ({
  onLiveStatus: () => {},
  onLiveSignal: (cb: (kind: string) => void) => {
    live.signal = cb;
  },
  startLive: live.start,
  stopLive: live.stop,
}));

import { resetDevice } from "@/lib/account/resetDevice";
import { authApi } from "@/lib/api/auth";
import { clearAccessToken } from "../../lib/crypto/crypto";
import { useAuthStore } from "./authStore";

const user = {
  id: "u1",
  email: "a@example.com",
  initialized: true,
  auth_provider: "password",
  created_at: "2026-01-01",
};

describe("live signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r" } as never,
      isAuthenticated: true,
      serverAuthenticated: false,
      isUnlocked: true,
      appLocked: false,
      localAccessAccountId: "u1",
      deletionNotice: null,
    });
  });

  it("starts live on server sign-in and stops on sign-out", async () => {
    useAuthStore.setState({ serverAuthenticated: true });
    expect(live.start).toHaveBeenCalledTimes(1);
    await useAuthStore.getState().logout();
    expect(live.stop).toHaveBeenCalled();
  });

  it("device_revoked wipes while locked", async () => {
    useAuthStore.setState({
      serverAuthenticated: true,
      appLocked: true,
      isUnlocked: false,
    });
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "active",
      device_revoked: true,
    });
    vi.mocked(resetDevice).mockImplementation(async (teardown) => {
      await teardown();
      return [];
    });
    live.signal?.("device_revoked");
    await vi.waitFor(() => expect(resetDevice).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(useAuthStore.getState().deletionNotice).toEqual({
        kind: "device_revoked",
      }),
    );
    expect(useAuthStore.getState().appLocked).toBe(false);
  });

  it("account_changed rechecks the session through the app's own refresh", async () => {
    // A second refresh racing the HTTP layer's would present a rotated token: the server reads
    // that as theft and signs out every device.
    const retry = vi.fn(async () => "connected" as const);
    useAuthStore.setState({
      serverAuthenticated: true,
      retryServerSession: retry,
    } as never);
    vi.mocked(authApi.me).mockResolvedValue(user as never);
    live.signal?.("account_changed");
    await vi.waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(1));
    expect(clearAccessToken).toHaveBeenCalled();
    expect(
      vi.mocked(clearAccessToken).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(authApi.me).mock.invocationCallOrder[0]);
    expect(authApi.refresh).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("restarts live after Keep on a scheduled deletion", () => {
    useAuthStore.setState({
      serverAuthenticated: true,
      pendingDeletion: "2026-12-13",
    });
    live.start.mockClear();
    useAuthStore.setState({ pendingDeletion: null });
    expect(live.start).toHaveBeenCalledTimes(1);
  });
});
