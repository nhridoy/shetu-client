import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({
  httpRequest: vi.fn(),
  HttpError: class HttpError extends Error {
    constructor(
      public readonly kind: "network" | "auth_expired",
      message: string,
    ) {
      super(message);
      this.name = "HttpError";
    }
  },
}));

import { AuthApiError, authApi } from "./auth";
import { HttpError, httpRequest } from "./http";

const mockHttpRequest = vi.mocked(httpRequest);

beforeEach(() => {
  mockHttpRequest.mockReset();
});

describe("apiFetch via facade", () => {
  it("returns the data envelope payload on 2xx", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      body: '{"data":{"email":"a@b.c"}}',
    });
    const user = await authApi.me();
    expect(user).toEqual({ email: "a@b.c" });
    expect(mockHttpRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/me",
      undefined,
      {},
    );
  });

  it("maps 4xx server error envelopes to AuthApiError", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 409,
      body: '{"error":{"code":"CONFLICT","message":"email already registered"}}',
    });
    await expect(authApi.register({} as never)).rejects.toMatchObject({
      name: "AuthApiError",
      status: 409,
      apiError: { code: "CONFLICT", message: "email already registered" },
    });
  });

  it("includes the email field of 4xx envelopes for VERIFICATION_REQUIRED", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      body: '{"error":{"code":"VERIFICATION_REQUIRED","message":"verify","email":"x@y.z"}}',
    });
    await expect(authApi.login({} as never)).rejects.toMatchObject({
      status: 400,
      apiError: { code: "VERIFICATION_REQUIRED", email: "x@y.z" },
    });
  });

  it("moves HttpError(network) to AuthApiError(0, NETWORK_ERROR)", async () => {
    mockHttpRequest.mockRejectedValue(
      new HttpError(
        "network",
        "Cannot reach the server. Check that it is running and your connection is online.",
      ),
    );
    await expect(authApi.prelogin("a@b.c")).rejects.toMatchObject({
      name: "AuthApiError",
      status: 0,
      apiError: { code: "NETWORK_ERROR" },
    });
  });

  it("moves HttpError(auth_expired) to AuthApiError(401, AUTH_EXPIRED)", async () => {
    mockHttpRequest.mockRejectedValue(
      new HttpError(
        "auth_expired",
        "Your session has expired. Please sign in again.",
      ),
    );
    await expect(authApi.me()).rejects.toMatchObject({
      name: "AuthApiError",
      status: 401,
      apiError: { code: "AUTH_EXPIRED" },
    });
  });

  it("uses auth: false for the refresh endpoint so Rust never loops on it", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      body: '{"data":{"access_token":"a","refresh_token":"r"}}',
    });
    const pair = await authApi.refresh("stale");
    expect(pair).toEqual({ access_token: "a", refresh_token: "r" });
    expect(mockHttpRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/auth/refresh",
      { refresh_token: "stale" },
      { auth: false },
    );
  });

  it("handles 204 as undefined for logout", async () => {
    mockHttpRequest.mockResolvedValue({ status: 204, body: "" });
    await expect(authApi.logout("rt")).resolves.toBeUndefined();
  });
});

describe("AuthApiError", () => {
  it("is an instanceof Error with name AuthApiError", () => {
    const err = new AuthApiError(403, { code: "X", message: "boom" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AuthApiError");
    expect(err.status).toBe(403);
    expect(err.apiError.code).toBe("X");
  });
});

describe("isShetuServer", () => {
  it("is true when the root answers with the Shetu banner", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      body: '{"message":"Shetu API"}',
    });
    await expect(authApi.isShetuServer()).resolves.toBe(true);
    expect(mockHttpRequest).toHaveBeenCalledWith("GET", "/", undefined, {
      auth: false,
    });
  });

  it("is false for a non-Shetu response or an unreachable server", async () => {
    mockHttpRequest.mockResolvedValueOnce({ status: 200, body: "<html>" });
    await expect(authApi.isShetuServer()).resolves.toBe(false);
    mockHttpRequest.mockRejectedValueOnce(new HttpError("network", "down"));
    await expect(authApi.isShetuServer()).resolves.toBe(false);
  });
});

describe("account deletion", () => {
  it("request_deletion_posts_proof_and_email", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      body: '{"data":{"deletion_scheduled_for":"2026-12-13T00:00:00Z"}}',
    });
    const body = { proof: "p", nonce: "n", email: "a@b.c" };
    await expect(authApi.requestAccountDeletion(body)).resolves.toEqual({
      deletion_scheduled_for: "2026-12-13T00:00:00Z",
    });
    expect(mockHttpRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/me/deletion",
      body,
      {},
    );
  });

  it("cancel_deletion_deletes", async () => {
    mockHttpRequest.mockResolvedValue({ status: 204, body: "" });
    await expect(authApi.cancelAccountDeletion()).resolves.toBeUndefined();
    expect(mockHttpRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/me/deletion",
      undefined,
      {},
    );
  });

  it("account_status_posts_user_id", async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      body: '{"data":{"status":"deletion_scheduled","deletion_scheduled_for":"2026-12-13T00:00:00Z"}}',
    });
    await expect(authApi.accountStatus("u1")).resolves.toEqual({
      status: "deletion_scheduled",
      deletion_scheduled_for: "2026-12-13T00:00:00Z",
    });
    // Public endpoint: must not attach (or try to refresh) a possibly revoked session.
    expect(mockHttpRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/auth/account-status",
      { user_id: "u1" },
      { auth: false },
    );
  });
});
