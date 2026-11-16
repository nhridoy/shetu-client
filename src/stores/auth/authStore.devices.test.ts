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
  },
  loadApiUrl: vi.fn(async () => {}),
  getApiUrl: vi.fn(() => "http://localhost:8080"),
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public status: number,
      public apiError: { code: string; message: string },
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
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
vi.mock("@/lib/api/devices", () => ({ reportDevice: vi.fn(async () => {}) }));
vi.mock("../../lib/common/device", () => ({
  getDeviceId: vi.fn(async () => "dev-1"),
}));

import { toast } from "sonner";
import { resetDevice } from "@/lib/account/resetDevice";
import { authApi } from "@/lib/api/auth";
import { reportDevice } from "@/lib/api/devices";
import { handleRevokedSession, useAuthStore } from "./authStore";

const user = {
  id: "u1",
  email: "a@example.com",
  initialized: true,
  auth_provider: "password",
  created_at: "2026-01-01",
};

describe("revoked devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetDevice).mockResolvedValue([]);
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r" } as never,
      isAuthenticated: true,
      serverAuthenticated: true,
      localAccessAccountId: "u1",
      deletionNotice: null,
    });
  });

  it("revoked_session_with_revoked_device_wipes", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "active",
      device_revoked: true,
    });
    await handleRevokedSession();
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1", "dev-1");
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionNotice).toEqual({
      kind: "device_revoked",
    });
  });

  it("revoked_session_status_error_keeps_data", async () => {
    vi.mocked(authApi.accountStatus).mockRejectedValue(new Error("offline"));
    await handleRevokedSession();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("login_on_revoked_device_wipes_first", async () => {
    useAuthStore.setState({
      serverAuthenticated: false,
      isAuthenticated: false,
    });
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "active",
      device_revoked: true,
    });
    vi.mocked(authApi.prelogin).mockRejectedValue(new Error("stop here"));
    await useAuthStore
      .getState()
      .login("a@example.com", "pw")
      .catch(() => {});
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1", "dev-1");
    expect(resetDevice).toHaveBeenCalledTimes(1);
    // The sign-in itself still goes ahead after the wipe.
    expect(authApi.prelogin).toHaveBeenCalled();
    expect(vi.mocked(resetDevice).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authApi.prelogin).mock.invocationCallOrder[0],
    );
  });

  it("login_without_local_account_skips_status_check", async () => {
    useAuthStore.setState({
      serverAuthenticated: false,
      isAuthenticated: false,
      localAccessAccountId: null,
      user: null,
    });
    vi.mocked(authApi.prelogin).mockRejectedValue(new Error("stop here"));
    await useAuthStore
      .getState()
      .login("a@example.com", "pw")
      .catch(() => {});
    expect(authApi.accountStatus).not.toHaveBeenCalled();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("sign_in_reports_device", () => {
    useAuthStore.setState({ serverAuthenticated: false });
    vi.mocked(reportDevice).mockClear();
    useAuthStore.setState({ serverAuthenticated: true });
    expect(reportDevice).toHaveBeenCalledTimes(1);
    useAuthStore.setState({ serverAuthenticated: true });
    expect(reportDevice).toHaveBeenCalledTimes(1);
  });

  it("the wipe notice is still shown after the sign-in that follows it", () => {
    useAuthStore.setState({
      isAuthenticated: false,
      deletionNotice: { kind: "device_revoked" },
    });
    useAuthStore.setState({ isAuthenticated: true });
    expect(toast.warning).toHaveBeenCalledWith(
      "This device was signed out from another device. Its Shetu data was erased.",
    );
    expect(useAuthStore.getState().deletionNotice).toBeNull();
  });
});
