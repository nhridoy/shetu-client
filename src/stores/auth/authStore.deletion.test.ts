import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  })),
}));
vi.mock("@/lib/api/auth", () => ({
  authApi: { accountStatus: vi.fn() },
  loadApiUrl: vi.fn(async () => {}),
  getApiUrl: vi.fn(() => "http://localhost:8080"),
  AuthApiError: class extends Error {},
}));
vi.mock("@/lib/account/resetDevice", () => ({ resetDevice: vi.fn() }));
vi.mock("../../lib/api/http", () => ({ onSessionRevoked: vi.fn() }));
vi.mock("../../lib/crypto/crypto", () => ({
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
import { authApi } from "@/lib/api/auth";
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
