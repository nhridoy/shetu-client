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
vi.mock("../../lib/common/device", () => ({
  getDeviceId: vi.fn(async () => "dev-1"),
}));

import { resetDevice } from "@/lib/account/resetDevice";
import { AuthApiError, authApi } from "@/lib/api/auth";
import { onSessionRevoked } from "../../lib/api/http";
import {
  clearAccessToken,
  clearAuthTokens,
  clearKeychain,
  loadRefreshToken,
  lockSession,
  saveRefreshToken,
  setAuthTokens,
} from "../../lib/crypto/crypto";
import {
  loadOfflineIdentity,
  saveOfflineIdentity,
} from "../../lib/crypto/offlineIdentity";
import { wipeLocalData } from "../../lib/db/db";
import { deletePassword } from "../../lib/keychain/keychain";
import { startOAuthFlow } from "../../lib/oauth/oauth";
import { handleRevokedSession, useAuthStore } from "./authStore";

// The listener the store registers on import; captured before any test clears mock calls.
const revokedListener = vi.mocked(onSessionRevoked).mock.calls[0]?.[0];

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

  it("session_revoked_event_runs_the_deletion_check", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "deletion_scheduled",
      deletion_scheduled_for: "2026-12-13",
    });
    expect(revokedListener).toBeTypeOf("function");
    revokedListener?.();
    await vi.waitFor(() => expect(resetDevice).toHaveBeenCalledTimes(1));
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1");
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

  it("suspend_keeps_the_refresh_token", async () => {
    // A refresh may have just stored a working token; the next retry reconnects with it.
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "active" });
    await handleRevokedSession();
    expect(clearAccessToken).toHaveBeenCalledTimes(1);
    expect(clearAuthTokens).not.toHaveBeenCalled();
    expect(clearKeychain).not.toHaveBeenCalled();
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
    // Earlier tests leave a rotated keychain token behind.
    vi.mocked(loadRefreshToken).mockResolvedValue(null);
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

  it("keep_after_sign_in_keeps_the_rotated_session", async () => {
    await useAuthStore.getState().login("a@example.com", "pw");
    expect(setAuthTokens).toHaveBeenCalledTimes(1);
    // Rust refreshed (and persisted) a new pair while the dialog was open.
    vi.mocked(loadRefreshToken).mockResolvedValue("r-rotated");
    vi.mocked(authApi.cancelAccountDeletion).mockResolvedValue();
    await useAuthStore.getState().cancelAccountDeletion();
    expect(setAuthTokens).toHaveBeenCalledTimes(1);
    expect(saveRefreshToken).not.toHaveBeenCalledWith("r");
    expect(useAuthStore.getState().tokens?.refresh_token).toBe("r-rotated");
  });

  it("keep_after_oauth_sign_in_keeps_the_rotated_session", async () => {
    vi.mocked(startOAuthFlow).mockResolvedValue({
      dest: "app",
      accessToken: "a",
      refreshToken: "r",
    } as never);
    vi.mocked(authApi.me).mockResolvedValue(scheduledUser);
    vi.mocked(authApi.fetchKeyring).mockResolvedValue({
      keyring,
      salt_cl: "sc",
    } as never);
    await useAuthStore.getState().oauthStartFlow("github");
    // Only what Keep does counts: the sign-in itself saved the pair once.
    vi.mocked(setAuthTokens).mockClear();
    vi.mocked(saveRefreshToken).mockClear();
    // Rust refreshed (and persisted) a new pair while the dialog was open.
    vi.mocked(loadRefreshToken).mockResolvedValue("r-rotated");
    vi.mocked(authApi.cancelAccountDeletion).mockResolvedValue();
    await useAuthStore.getState().cancelAccountDeletion();
    expect(setAuthTokens).not.toHaveBeenCalled();
    expect(saveRefreshToken).not.toHaveBeenCalledWith("r");
    expect(useAuthStore.getState().tokens?.refresh_token).toBe("r-rotated");
    expect(useAuthStore.getState().serverAuthenticated).toBe(true);
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

describe("restore with a revoked refresh token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetDevice).mockResolvedValue([]);
    vi.mocked(loadOfflineIdentity).mockResolvedValue({
      profile: user,
      salt_cl: "sc",
      wrapped_keyring: keyring,
    } as never);
    useAuthStore.setState({
      user,
      tokens: null,
      isAuthenticated: false,
      serverAuthenticated: false,
      localAccessAccountId: "u1",
      deletionNotice: null,
      pendingDeletion: null,
    });
  });

  // Rust only reports session-revoked for authenticated calls; refresh is not one.
  const rejectRefresh = (code = "UNAUTHORIZED") => {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("revoked");
    vi.mocked(authApi.refresh).mockRejectedValueOnce(apiError(401, code));
  };

  it("restore_with_revoked_refresh_asks_status", async () => {
    rejectRefresh();
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "deletion_scheduled",
      deletion_scheduled_for: "2026-12-13",
    });
    expect(await useAuthStore.getState().retryServerSession()).toBe(
      "auth-required",
    );
    await vi.waitFor(() => expect(resetDevice).toHaveBeenCalledTimes(1));
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1");
    expect(useAuthStore.getState().deletionNotice).toEqual({
      kind: "scheduled",
      date: "2026-12-13",
    });
  });

  it("restore_with_revoked_refresh_for_active_account_keeps_data", async () => {
    rejectRefresh();
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "active" });
    await useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(authApi.accountStatus).toHaveBeenCalled());
    await handleRevokedSession(); // let the run in flight finish
    expect(resetDevice).not.toHaveBeenCalled();
    expect(useAuthStore.getState().localAccessAccountId).toBe("u1");
  });

  it("late_session_retry_after_a_reset_stays_signed_out", async () => {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a2",
      refresh_token: "r2",
    });
    let resolveMe: (u: typeof user) => void = () => {};
    vi.mocked(authApi.me).mockReturnValueOnce(
      new Promise((r) => {
        resolveMe = r;
      }) as never,
    );
    useAuthStore.setState({ user });
    const retry = useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(authApi.me).toHaveBeenCalled());
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "deleted" });
    vi.mocked(resetDevice).mockImplementationOnce(async (teardown) => {
      await teardown();
      return [];
    });
    await handleRevokedSession();
    resolveMe(user);
    await retry;
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.serverAuthenticated).toBe(false);
    expect(s.localAccessAccountId).toBeNull();
    expect(saveRefreshToken).not.toHaveBeenCalled();
  });

  // Starts a retry whose /me stays pending; returns the retry and /me's settlers.
  async function retryWithPendingMe() {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a2",
      refresh_token: "r2",
    });
    const me: {
      resolve: (u: typeof user) => void;
      reject: (e: unknown) => void;
    } = { resolve: () => {}, reject: () => {} };
    vi.mocked(authApi.me).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        Object.assign(me, { resolve, reject });
      }) as never,
    );
    const retry = useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(authApi.me).toHaveBeenCalled());
    return { retry, me };
  }

  it("failed_stale_retry_leaves_a_fresh_sign_in_alone", async () => {
    useAuthStore.setState({ user });
    const { retry, me } = await retryWithPendingMe();
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "deleted" });
    vi.mocked(resetDevice).mockImplementationOnce(async (teardown) => {
      await teardown();
      return [];
    });
    await handleRevokedSession();
    const fresh = { access_token: "a3", refresh_token: "r3" };
    useAuthStore.setState({
      user,
      tokens: fresh,
      isAuthenticated: true,
      serverAuthenticated: true,
    });
    me.reject(new Error("timeout"));
    await retry;
    const s = useAuthStore.getState();
    expect(s.tokens).toEqual(fresh);
    expect(s.isAuthenticated).toBe(true);
    expect(s.serverAuthenticated).toBe(true);
  });

  it("retry_finishing_after_logout_stays_signed_out", async () => {
    useAuthStore.setState({ user });
    const { retry, me } = await retryWithPendingMe();
    await useAuthStore.getState().logout();
    me.resolve(user);
    await retry;
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.localAccessAccountId).toBeNull();
    expect(saveRefreshToken).not.toHaveBeenCalled();
  });

  // A refresh rejected earlier cleared the keychain, but the status call then failed.
  it("enrolled_launch_without_refresh_token_resets_a_scheduled_account", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({
      status: "deletion_scheduled",
      deletion_scheduled_for: "2026-12-13",
    });
    expect(await useAuthStore.getState().retryServerSession()).toBe(
      "auth-required",
    );
    await vi.waitFor(() => expect(resetDevice).toHaveBeenCalledTimes(1));
    expect(authApi.accountStatus).toHaveBeenCalledWith("u1");
  });

  it("enrolled_launch_without_refresh_token_keeps_an_active_account", async () => {
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "active" });
    await useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(authApi.accountStatus).toHaveBeenCalled());
    await handleRevokedSession(); // let the run in flight finish
    expect(resetDevice).not.toHaveBeenCalled();
    expect(useAuthStore.getState().localAccessAccountId).toBe("u1");
  });

  it("fresh_install_without_refresh_token_does_not_ask_status", async () => {
    vi.mocked(loadOfflineIdentity).mockResolvedValue(null);
    useAuthStore.setState({ user: null, localAccessAccountId: null });
    expect(await useAuthStore.getState().retryServerSession()).toBe(
      "auth-required",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(authApi.accountStatus).not.toHaveBeenCalled();
    expect(clearAccessToken).not.toHaveBeenCalled();
  });

  it("restore_offline_or_expired_does_not_ask_status", async () => {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockRejectedValueOnce(
      apiError(0, "NETWORK_ERROR"),
    );
    expect(await useAuthStore.getState().retryServerSession()).toBe("offline");
    rejectRefresh("AUTH_EXPIRED");
    await useAuthStore.getState().retryServerSession();
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a",
      refresh_token: "r",
    });
    vi.mocked(authApi.me).mockResolvedValueOnce({ ...user, id: "u2" });
    await useAuthStore.getState().retryServerSession();
    await new Promise((r) => setTimeout(r, 0));
    expect(authApi.accountStatus).not.toHaveBeenCalled();
  });
});

describe("sign-in and sign-out", () => {
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

  it("scheduled_login_for_a_different_enrolled_account_is_refused", async () => {
    vi.mocked(loadOfflineIdentity).mockResolvedValue({
      profile: { ...user, id: "other" },
      salt_cl: "sc",
      wrapped_keyring: keyring,
    } as never);
    await expect(
      useAuthStore.getState().login("a@example.com", "pw"),
    ).rejects.toThrow("Another account is enrolled on this device");
    const s = useAuthStore.getState();
    expect(setAuthTokens).not.toHaveBeenCalled();
    expect(saveRefreshToken).not.toHaveBeenCalled();
    expect(s.pendingDeletion).toBeNull();
    expect(s.error).toMatch("Another account is enrolled on this device");
    expect(saveOfflineIdentity).not.toHaveBeenCalled();
    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("scheduled_oauth_for_a_different_enrolled_account_is_refused", async () => {
    vi.mocked(loadOfflineIdentity).mockResolvedValue({
      profile: { ...user, id: "other" },
      salt_cl: "sc",
      wrapped_keyring: keyring,
    } as never);
    vi.mocked(startOAuthFlow).mockResolvedValue({
      dest: "app",
      accessToken: "a",
      refreshToken: "r",
    } as never);
    vi.mocked(authApi.me).mockResolvedValue(scheduledUser);
    await expect(
      useAuthStore.getState().oauthStartFlow("github"),
    ).rejects.toThrow("Another account is enrolled on this device");
    const s = useAuthStore.getState();
    expect(s.pendingDeletion).toBeNull();
    expect(s.error).toMatch("Another account is enrolled on this device");
    expect(clearAuthTokens).toHaveBeenCalled();
    expect(clearKeychain).toHaveBeenCalled();
    expect(saveOfflineIdentity).not.toHaveBeenCalled();
    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(resetDevice).not.toHaveBeenCalled();
  });

  it("keep_then_resume_failure_shows_error", async () => {
    vi.mocked(loadOfflineIdentity).mockResolvedValue(null);
    await useAuthStore.getState().login("a@example.com", "pw");
    vi.mocked(saveOfflineIdentity).mockRejectedValueOnce(
      new Error("disk full"),
    );
    vi.mocked(authApi.cancelAccountDeletion).mockResolvedValue();
    await useAuthStore.getState().cancelAccountDeletion();
    const s = useAuthStore.getState();
    expect(s.pendingDeletion).toBeNull();
    expect(s.error).toBe("disk full");
    expect(s.isLoading).toBe(false);
  });

  it("logout_revokes_the_latest_refresh_token", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r-stale" },
    });
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r-live");
    await useAuthStore.getState().logout();
    expect(authApi.logout).toHaveBeenCalledWith("r-live");
  });

  it("logout_falls_back_to_the_store_token", async () => {
    useAuthStore.setState({
      user,
      tokens: { access_token: "a", refresh_token: "r-mirror" },
    });
    vi.mocked(loadRefreshToken).mockRejectedValueOnce(new Error("keychain"));
    await useAuthStore.getState().logout();
    expect(authApi.logout).toHaveBeenCalledWith("r-mirror");
  });

  it("reset_teardown_reports_a_failed_local_wipe", async () => {
    vi.mocked(authApi.requestAccountDeletion).mockResolvedValue({
      deletion_scheduled_for: "2026-12-13",
    });
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    useAuthStore.setState({ user, localAccessAccountId: "u1" });
    vi.mocked(wipeLocalData).mockRejectedValueOnce(new Error("db locked"));
    let returned: unknown;
    vi.mocked(resetDevice).mockImplementationOnce(async (teardown) => {
      returned = await teardown();
      return [];
    });
    await useAuthStore.getState().requestAccountDeletion("pw", "a@example.com");
    expect(returned).toEqual([expect.stringContaining("db locked")]);
  });

  it("reset_teardown_reports_a_failed_keychain_delete", async () => {
    // Rust still drops the access token and blocks refresh, then reports the error.
    useAuthStore.setState({ user, localAccessAccountId: "u1" });
    vi.mocked(clearAuthTokens).mockRejectedValueOnce("keychain locked");
    let returned: unknown;
    vi.mocked(resetDevice).mockImplementationOnce(async (teardown) => {
      returned = await teardown();
      return [];
    });
    vi.mocked(authApi.accountStatus).mockResolvedValue({ status: "deleted" });
    await handleRevokedSession();
    expect(returned).toEqual(["session tokens: keychain locked"]);
  });

  it("sign_out_clears_the_native_session_before_the_keychain", async () => {
    // A native refresh finishing after the session clear stores nothing; one
    // finishing before it has its rotated token removed by the keychain clear.
    useAuthStore.setState({ user, localAccessAccountId: "u1" });
    await useAuthStore.getState().logout();
    const [session] = vi.mocked(clearAuthTokens).mock.invocationCallOrder;
    const [keychain] = vi.mocked(clearKeychain).mock.invocationCallOrder;
    expect(session).toBeDefined();
    expect(keychain).toBeDefined();
    expect(session).toBeLessThan(keychain);
  });

  it("teardown_finishes_even_if_locking_fails", async () => {
    useAuthStore.setState({ user, localAccessAccountId: "u1" });
    vi.mocked(lockSession).mockRejectedValueOnce(new Error("lock failed"));
    await useAuthStore.getState().logout();
    expect(deletePassword).toHaveBeenCalled();
    expect(clearAuthTokens).toHaveBeenCalled();
    expect(wipeLocalData).toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().localAccessAccountId).toBeNull();
  });
});

describe("token writes racing a teardown", () => {
  // Stand-ins for Rust's in-memory access token and the keychain refresh token.
  let access: string | null;
  let keychain: string | null;
  // Stand-in for the offline identity a sign-in enrolls and the wipe deletes.
  let enrolled: string | null;
  let landStaleWrite: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    access = null;
    keychain = "r";
    enrolled = null;
    // Answers queued by earlier tests (clearAllMocks keeps them) would skip the races below.
    vi.mocked(authApi.me).mockReset();
    vi.mocked(authApi.refresh).mockReset();
    vi.mocked(loadRefreshToken).mockReset().mockResolvedValue(null);
    vi.mocked(saveOfflineIdentity).mockImplementation(async (identity) => {
      enrolled = identity.profile.id;
    });
    vi.mocked(wipeLocalData).mockImplementation(async () => {
      enrolled = null;
    });
    vi.mocked(resetDevice).mockResolvedValue([]);
    vi.mocked(loadOfflineIdentity).mockResolvedValue(null);
    vi.mocked(clearAuthTokens).mockImplementation(async () => {
      access = null;
    });
    vi.mocked(clearKeychain).mockImplementation(async () => {
      keychain = null;
    });
    vi.mocked(saveRefreshToken).mockImplementation(async (token) => {
      keychain = token;
    });
    // Like set_auth_tokens: sets the access token and persists the refresh token.
    const write = (a: string, r?: string) => {
      access = a;
      if (r) keychain = r;
    };
    vi.mocked(setAuthTokens).mockImplementation(async (a, r) => write(a, r));
    useAuthStore.setState({
      user,
      tokens: null,
      isAuthenticated: false,
      serverAuthenticated: false,
      localAccessAccountId: "u1",
      deletionNotice: null,
      pendingDeletion: null,
      error: null,
      isLoading: false,
    });
  });

  // A session retry whose setAuthTokens lands only when landStaleWrite() is called.
  async function retryWithSlowWrite() {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a2",
      refresh_token: "r2",
    });
    vi.mocked(authApi.me).mockResolvedValueOnce(user);
    const write = vi.mocked(setAuthTokens).getMockImplementation();
    vi.mocked(setAuthTokens).mockImplementationOnce(
      (a, r) =>
        new Promise((done) => {
          landStaleWrite = () => done(write?.(a, r));
        }),
    );
    const retry = useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(setAuthTokens).toHaveBeenCalledTimes(1));
    return { retry };
  }

  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("token_write_landing_after_sign_out_leaves_no_session", async () => {
    const { retry } = await retryWithSlowWrite();
    const signOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(useAuthStore.getState().user).toBeNull());
    await settle();
    landStaleWrite();
    await Promise.all([signOut, retry]);
    expect(access).toBeNull();
    expect(keychain).toBeNull();
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it("fresh_sign_in_keeps_its_tokens_when_a_stale_write_lands_late", async () => {
    const { retry } = await retryWithSlowWrite();
    const signOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(useAuthStore.getState().user).toBeNull());
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    vi.mocked(authApi.login).mockResolvedValue({
      access_token: "a3",
      refresh_token: "r3",
      user,
      keyring,
    } as never);
    const signIn = useAuthStore.getState().login("a@example.com", "pw");
    await settle();
    landStaleWrite();
    await Promise.all([signOut, signIn, retry]);
    expect(access).toBe("a3");
    expect(keychain).toBe("r3");
    expect(useAuthStore.getState().tokens).toEqual({
      access_token: "a3",
      refresh_token: "r3",
    });
  });

  it("login_and_refresh_write_tokens_once", async () => {
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    vi.mocked(authApi.login).mockResolvedValue({
      access_token: "a3",
      refresh_token: "r3",
      user,
      keyring,
    } as never);
    await useAuthStore.getState().login("a@example.com", "pw");
    expect(setAuthTokens).toHaveBeenCalledTimes(1);
    expect(setAuthTokens).toHaveBeenCalledWith("a3", "r3");
    expect(saveRefreshToken).toHaveBeenCalledTimes(1);
    expect([access, keychain]).toEqual(["a3", "r3"]);

    vi.mocked(setAuthTokens).mockClear();
    vi.mocked(saveRefreshToken).mockClear();
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r3");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a4",
      refresh_token: "r4",
    });
    vi.mocked(authApi.me).mockResolvedValueOnce(user);
    expect(await useAuthStore.getState().retryServerSession()).toBe(
      "connected",
    );
    expect(setAuthTokens).toHaveBeenCalledTimes(1);
    expect(saveRefreshToken).toHaveBeenCalledTimes(1);
    expect([access, keychain]).toEqual(["a4", "r4"]);
  });

  const mockSignIn = () => {
    vi.mocked(authApi.prelogin).mockResolvedValue({
      nonce: "n",
      kdf: { m: 1, t: 1, p: 1 },
      server_salt: "ss",
      salt_cl: "sc",
    });
    vi.mocked(authApi.login).mockResolvedValue({
      access_token: "a3",
      refresh_token: "r3",
      user,
      keyring,
    } as never);
  };

  // A session retry whose /me stays pending until settled.
  async function retryWithPendingMe() {
    vi.mocked(loadRefreshToken).mockResolvedValueOnce("r");
    vi.mocked(authApi.refresh).mockResolvedValueOnce({
      access_token: "a2",
      refresh_token: "r2",
    });
    const me: {
      resolve: (u: typeof user) => void;
      reject: (e: unknown) => void;
    } = { resolve: () => {}, reject: () => {} };
    vi.mocked(authApi.me).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        Object.assign(me, { resolve, reject });
      }) as never,
    );
    const retry = useAuthStore.getState().retryServerSession();
    await vi.waitFor(() => expect(authApi.me).toHaveBeenCalled());
    return { retry, me };
  }

  const expectNewerSignIn = () => {
    expect([access, keychain]).toEqual(["a3", "r3"]);
    const s = useAuthStore.getState();
    expect(s.tokens).toEqual({ access_token: "a3", refresh_token: "r3" });
    expect(s.isAuthenticated).toBe(true);
    expect(s.serverAuthenticated).toBe(true);
  };

  it("sign_in_in_flight_across_a_sign_out_leaves_no_session", async () => {
    mockSignIn();
    let answer: (v: unknown) => void = () => {};
    vi.mocked(authApi.login).mockReturnValueOnce(
      new Promise((r) => {
        answer = r;
      }) as never,
    );
    const signIn = useAuthStore.getState().login("a@example.com", "pw");
    await vi.waitFor(() => expect(authApi.login).toHaveBeenCalled());
    await useAuthStore.getState().logout();
    answer({ access_token: "a3", refresh_token: "r3", user, keyring });
    await signIn;
    await settle();
    expect([access, keychain, enrolled]).toEqual([null, null, null]);
    expect(saveRefreshToken).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.localAccessAccountId).toBeNull();
    expect(s.isLoading).toBe(false);
  });

  it("sign_in_during_a_sign_out_is_not_left_half_wiped", async () => {
    // The stale write holds the sign-out in the token queue, before its wipe.
    const { retry } = await retryWithSlowWrite();
    const signOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(useAuthStore.getState().user).toBeNull());
    mockSignIn();
    const signIn = useAuthStore.getState().login("a@example.com", "pw");
    await settle();
    landStaleWrite();
    await Promise.all([signOut, signIn, retry]);
    const s = useAuthStore.getState();
    expect(s.isAuthenticated ? "u1" : null).toBe(enrolled);
    expect(s.localAccessAccountId).toBe(enrolled);
    // It started after the sign-out began, so it owns the next session.
    expect(enrolled).toBe("u1");
  });

  it("failed_old_retry_leaves_a_newer_sign_in_alone", async () => {
    const { retry, me } = await retryWithPendingMe();
    mockSignIn();
    await useAuthStore.getState().login("a@example.com", "pw");
    me.reject(new Error("timeout"));
    await retry;
    expectNewerSignIn();
  });

  it("succeeding_old_retry_leaves_a_newer_sign_in_alone", async () => {
    const { retry, me } = await retryWithPendingMe();
    mockSignIn();
    await useAuthStore.getState().login("a@example.com", "pw");
    me.resolve(user);
    await retry;
    expectNewerSignIn();
  });

  it("sign_in_after_a_sign_out_succeeds", async () => {
    await useAuthStore.getState().logout();
    mockSignIn();
    await useAuthStore.getState().login("a@example.com", "pw");
    expectNewerSignIn();
    expect(enrolled).toBe("u1");
    expect(useAuthStore.getState().localAccessAccountId).toBe("u1");
  });

  it("sign_in_waits_for_every_running_sign_out", async () => {
    const wipes: Array<() => void> = [];
    vi.mocked(wipeLocalData).mockImplementation(
      () =>
        new Promise<void>((done) => {
          wipes.push(() => {
            enrolled = null;
            done();
          });
        }),
    );
    const first = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(wipes).toHaveLength(1));
    mockSignIn();
    const signIn = useAuthStore.getState().login("a@example.com", "pw");
    const second = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(wipes).toHaveLength(2));
    wipes[0]();
    await first;
    await settle();
    expect(authApi.prelogin).not.toHaveBeenCalled();
    wipes[1]();
    await Promise.all([second, signIn]);
    expect(enrolled).toBe("u1");
    expectNewerSignIn();
  });

  it("sign_in_waits_for_an_earlier_sign_out_that_finishes_last", async () => {
    const wipes: Array<() => void> = [];
    vi.mocked(wipeLocalData).mockImplementation(
      () =>
        new Promise<void>((done) => {
          wipes.push(() => {
            enrolled = null;
            done();
          });
        }),
    );
    const first = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(wipes).toHaveLength(1));
    const second = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(wipes).toHaveLength(2));
    wipes[1]();
    await second;
    mockSignIn();
    const signIn = useAuthStore.getState().login("a@example.com", "pw");
    await settle();
    expect(authApi.prelogin).not.toHaveBeenCalled();
    wipes[0]();
    await Promise.all([first, signIn]);
    expect(enrolled).toBe("u1");
    expectNewerSignIn();
  });
});
