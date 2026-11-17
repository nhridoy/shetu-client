import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({
  httpRequest: vi.fn(),
  HttpError: class HttpError extends Error {},
}));

import { AuthApiError } from "./auth";
import { httpRequest } from "./http";
import { isTwoFactorRequired, twoFactorApi } from "./twoFactor";

const request = vi.mocked(httpRequest);
const ok = (body: unknown = null, status = 200) => ({
  status,
  body: body === null ? "" : JSON.stringify({ data: body }),
});
const called = () => request.mock.calls.map((c) => [c[0], c[1], c[2]]);

beforeEach(() => request.mockReset());

describe("two-factor API", () => {
  it("settings calls hit the right endpoints", async () => {
    request.mockResolvedValue(ok({ backup_codes: ["a"] }));
    await twoFactorApi.status();
    await twoFactorApi.startSetup();
    await twoFactorApi.confirm("123456", "654321");
    await twoFactorApi.confirm("123456");
    await twoFactorApi.disable("123456");
    await twoFactorApi.regenerateBackupCodes("123456");
    expect(called()).toEqual([
      ["GET", "/api/v1/me/two-factor", undefined],
      ["POST", "/api/v1/me/two-factor/setup", {}],
      [
        "POST",
        "/api/v1/me/two-factor/confirm",
        { code: "123456", email_code: "654321" },
      ],
      ["POST", "/api/v1/me/two-factor/confirm", { code: "123456" }],
      ["POST", "/api/v1/me/two-factor/disable", { code: "123456" }],
      ["POST", "/api/v1/me/two-factor/backup-codes", { code: "123456" }],
    ]);
  });

  it("verify and email code send the challenge", async () => {
    request.mockResolvedValue(ok({ access_token: "a" }));
    await expect(twoFactorApi.verify("ch", "123456", "totp")).resolves.toEqual({
      access_token: "a",
    });
    request.mockResolvedValue(ok(null, 204));
    await twoFactorApi.sendEmailCode("ch");
    expect(called()).toEqual([
      [
        "POST",
        "/api/v1/auth/two-factor",
        { challenge: "ch", code: "123456", kind: "totp" },
      ],
      ["POST", "/api/v1/auth/two-factor/email", { challenge: "ch" }],
    ]);
  });

  it("errors keep their server code", async () => {
    request.mockResolvedValue({
      status: 401,
      body: JSON.stringify({
        error: {
          code: "TWO_FACTOR_INVALID",
          message: "That code isn't right.",
        },
      }),
    });
    await expect(twoFactorApi.verify("ch", "1", "totp")).rejects.toMatchObject({
      apiError: { code: "TWO_FACTOR_INVALID" },
      message: "That code isn't right.",
    });
  });
});

describe("isTwoFactorRequired", () => {
  it("needs the code and a challenge", () => {
    const required = new AuthApiError(401, {
      code: "TWO_FACTOR_REQUIRED",
      message: "m",
      challenge: "ch",
    });
    expect(isTwoFactorRequired(required)).toBe(true);
    expect(
      isTwoFactorRequired(
        new AuthApiError(401, { code: "TWO_FACTOR_REQUIRED", message: "m" }),
      ),
    ).toBe(false);
    expect(
      isTwoFactorRequired(
        new AuthApiError(401, { code: "UNAUTHORIZED", message: "m" }),
      ),
    ).toBe(false);
    expect(isTwoFactorRequired(new Error("x"))).toBe(false);
  });
});
