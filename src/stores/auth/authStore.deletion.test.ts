import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { resetDevice } from "@/lib/account/resetDevice";
import { AuthApiError, authApi } from "@/lib/api/auth";
import { loadRefreshToken } from "../../lib/crypto/crypto";
import { saveOfflineIdentity } from "../../lib/crypto/offlineIdentity";
import { startOAuthFlow } from "../../lib/oauth/oauth";
import { handleRevokedSession, useAuthStore } from "./authStore";

const user = {
  id: "u1",
  email: "a@example.com",
  initialized: true,
  auth_provider: "password",
  created_at: "2026-01-01",
};

describe("handleRevokedSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetDevice).mockResolvedValue([]);
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r" } as never,
      isAuthenticated: true,
      serverAuthenticated: true,
      deletionNotice: null,
    });
  });

  it("revoked_session_for_scheduled_account_resets", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "deletion_scheduled",
      deletion_scheduled_for: "2026-12-13",
    });
    await handleRevokedSession();
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1");
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionNotice).toEqual({
      kind: "scheduled",
      date: "2026-12-13",
    });
  });

  it("revoked_session_for_deleted_account_resets", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "deleted" });
    await handleRevokedSession();
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionNotice).toEqual({ kind: "deleted" });
  });

  it("revoked_session_for_active_account_suspends", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "active" });
    await handleRevokedSession();
    expect(resetDevice).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.serverAuthenticated).toBe(false);
    expect(s.user).toEqual(user);
    expect(s.deletionNotice).toBeNull();
  });

  it("revoked_session_with_status_error_suspends", async () => {
    vi.mocked(authApi.accountStatus).mockRejectedValue(new Error("offline"));
    await handleRevokedSession();
    expect(resetDevice).not.toHaveBeenCalled();
    expect(useAuthStore.getState().serverAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it("revoked_session_with_unknown_status_suspends", async () => {
    for (const res of [{ status: "weird" }, {}, null]) {
      vi.mocked(authApi.accountStatus).mockResolvedValue(res as never);
      await handleRevokedSession();
      expect(resetDevice).not.toHaveBeenCalled();
      expect(useAuthStore.getState().serverAuthenticated).toBe(false);
      useAuthStore.setState({ serverAuthenticated: true });
    }
  });

  it("concurrent_revoked_sessions_share_one_run", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "deleted" });
    await Promise.all([handleRevokedSession(), handleRevokedSession()]);
    expect(authApi.accountStatus).toHaveBeenCalledTimes(1);
    expect(resetDevice).toHaveBeenCalledTimes(1);
  });

  it("revoked_session_for_a_switched_user_does_not_reset", async () => {
    let answer: (v: { status: "deleted" }) => void = () => {};
    vi.mocked(authApi.accountStatus).mockReturnValue(
      new Promise((r) => {
        answer = r;
      }),
    );
    const run = handleRevokedSession();
    await vi.waitFor(() => expect(authApi.accountStatus).toHaveBeenCalled());
    useAuthStore.setState({ user: { ...user, id: "u2" } });
    answer({ status: "deleted" });
    await run;
    expect(resetDevice).not.toHaveBeenCalled();
    expect(useAuthStore.getState().deletionNotice).toBeNull();
  });
});

const apiError = (status: number, code: string) =>
  new AuthApiError(status, { code, message: code });

describe("requestAccountDeletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetDevice).mockResolvedValue([]);
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r" },
      isAuthenticated: true,
      serverAuthenticated: true,
      isUnlocked: true,
      localAccessAccountId: "u1",
      deletionNotice: null,
    });
  });

  it("request_success_resets_and_sets_notice", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockResolvedValue({
      deletion_scheduled_for: "2026-12-13",
    });
    await useAuthStore.getState().requestAccountDeletion("pw", "a@example.com");
    expect(authApi.prelogin).toHaveBeenCalledWith("a@example.com");
    expect(authApi.requestAccountDeletion).toHaveBeenCalledWith({
      proof: "proof",
      nonce: "n",
      email: "a@example.com",
    });
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().deletionNotice).toEqual({
      kind: "scheduled",
      date: "2026-12-13",
    });
  });

  it("request_failure_keeps_everything", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockRejectedValue(
      apiError(403, "FORBIDDEN"),
    );
    await expect(
      useAuthStore.getState().requestAccountDeletion("bad", "a@example.com"),
    ).rejects.toThrow("That password is incorrect.");
    expect(resetDevice).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.user).toEqual(user);
    expect(s.serverAuthenticated).toBe(true);
    expect(s.isUnlocked).toBe(true);
    expect(s.deletionNotice).toBeNull();
  });

  it("request_maps_404_to_unsupported_server", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockRejectedValue(
      apiError(404, "NOT_FOUND"),
    );
    await expect(
      useAuthStore.getState().requestAccountDeletion("pw", "a@example.com"),
    ).rejects.toThrow("Your server doesn't support account deletion yet.");
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("request_maps_400_to_email_mismatch", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockRejectedValue(
      apiError(400, "EMAIL_MISMATCH"),
    );
    await expect(
      useAuthStore.getState().requestAccountDeletion("pw", "b@example.com"),
    ).rejects.toThrow("That email doesn't match your account.");
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("request_other_failure_keeps_its_message", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockRejectedValue(
      apiError(0, "NETWORK_ERROR"),
    );
    await expect(
      useAuthStore.getState().requestAccountDeletion("pw", "a@example.com"),
    ).rejects.toThrow("NETWORK_ERROR");
    expect(resetDevice).not.toHaveBeenCalled();
    expect(useAuthStore.getState().serverAuthenticated).toBe(true);
  });
});

const scheduledUser = { ...user, deletion_scheduled_for: "2026-12-13" };
const keyring = {
  dek_wrapped_by_kek: "kek",
  dek_wrapped_by_recovery: "rec",
  private_key_wrapped_by_dek: "pk",
};

// Only these may run before the user picks Keep or Sign out.
const allowedBeforeChoice = new Set(["prelogin", "login", "refresh", "me"]);
function gatedCalls(): string[] {
  return Object.entries(authApi)
    .filter(([name, fn]) => {
      return !allowedBeforeChoice.has(name) && vi.mocked(fn).mock.calls.length;
    })
    .map(([name]) => name);
}

describe("grace-period sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetDevice).mockResolvedValue([]);
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    vi.mocked(authApi.login).mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      user: scheduledUser,
      keyring,
    } as never);
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      serverAuthenticated: false,
      isUnlocked: false,
      localAccessAccountId: null,
      deletionNotice: null,
      pendingDeletion: null,
      error: null,
      isLoading: false,
    });
  });

  it("login_with_scheduled_account_sets_pending_deletion", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    const s = useAuthStore.getState();
    expect(s.pendingDeletion).toBe("2026-12-13");
    expect(s.isLoading).toBe(false);
    expect(s.serverAuthenticated).toBe(false);
    expect(s.isUnlocked).toBe(false);
    expect(s.localAccessAccountId).toBeNull();
  });

  it("scheduled_login_calls_nothing_else_before_the_choice", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    expect(gatedCalls()).toEqual([]);
    expect(saveOfflineIdentity).not.toHaveBeenCalled();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("scheduled_restore_calls_nothing_else_before_the_choice", async () => {
    vi.mocked(loadRefreshToken).mockResolvedValue("r");
    vi.mocked(authApi.refresh).mockResolvedValue({
      access_token: "a2",
      refresh_token: "r2",
    });
    vi.mocked(authApi.me).mockResolvedValue(scheduledUser);
    const first = await useAuthStore.getState().retryServerSession();
    expect(first).not.toBe("connected");
    expect(useAuthStore.getState().pendingDeletion).toBe("2026-12-13");
    expect(useAuthStore.getState().serverAuthenticated).toBe(false);
    // Sync retries the session every 30s; none may reach the server.
    await useAuthStore.getState().retryServerSession();
    expect(authApi.refresh).toHaveBeenCalledTimes(1);
    expect(gatedCalls()).toEqual([]);
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("scheduled_oauth_calls_nothing_else_before_the_choice", async () => {
    vi.mocked(startOAuthFlow).mockResolvedValue({
      dest: "app",
      accessToken: "a",
      refreshToken: "r",
    } as never);
    vi.mocked(authApi.me).mockResolvedValue(scheduledUser);
    await useAuthStore.getState().oauthStartFlow("github");
    const s = useAuthStore.getState();
    expect(s.pendingDeletion).toBe("2026-12-13");
    expect(s.serverAuthenticated).toBe(false);
    expect(gatedCalls()).toEqual([]);
  });

  it("cancel_clears_pending_deletion", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    vi.mocked(authApi.cancelAccountDeletion).mockResolvedValue();
    await useAuthStore.getState().cancelAccountDeletion();
    const s = useAuthStore.getState();
    expect(s.pendingDeletion).toBeNull();
    // Sign-in continues where it stopped.
    expect(s.serverAuthenticated).toBe(true);
    expect(s.isUnlocked).toBe(true);
    expect(s.localAccessAccountId).toBe("u1");
    expect(saveOfflineIdentity).toHaveBeenCalled();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("cancel_after_purge_resets_with_deleted_notice", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    vi.mocked(authApi.cancelAccountDeletion).mockRejectedValue(
      apiError(410, "ACCOUNT_DELETED"),
    );
    await useAuthStore.getState().cancelAccountDeletion();
    const s = useAuthStore.getState();
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(s.deletionNotice).toEqual({ kind: "deleted" });
    expect(s.pendingDeletion).toBeNull();
    expect(s.isUnlocked).toBe(false);
    expect(saveOfflineIdentity).not.toHaveBeenCalled();
  });

  it("cancel_failure_keeps_the_choice_open", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    vi.mocked(authApi.cancelAccountDeletion).mockRejectedValue(
      apiError(0, "NETWORK_ERROR"),
    );
    await expect(
      useAuthStore.getState().cancelAccountDeletion(),
    ).rejects.toThrow();
    expect(useAuthStore.getState().pendingDeletion).toBe("2026-12-13");
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("sign_out_during_choice_clears_pending_deletion", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().pendingDeletion).toBeNull();
    expect(authApi.logout).toHaveBeenCalledWith("r");
  });
});
