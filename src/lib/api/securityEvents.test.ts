import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({
  httpRequest: vi.fn(),
  HttpError: class HttpError extends Error {},
}));

import { httpRequest } from "./http";
import { securityEventsApi } from "./securityEvents";

const request = vi.mocked(httpRequest);
const page = { events: [{ id: 3, kind: "sign_in" }], next: 3 };

beforeEach(() => request.mockReset());

describe("security events API", () => {
  it("lists the first page and the next one", async () => {
    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ data: page }),
    });
    await expect(securityEventsApi.list()).resolves.toEqual(page);
    await securityEventsApi.list(42);
    expect(request.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["GET", "/api/v1/me/security-events"],
      ["GET", "/api/v1/me/security-events?before=42"],
    ]);
  });

  it("throws the server's message", async () => {
    request.mockResolvedValue({
      status: 500,
      body: JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "failed to list security events",
        },
      }),
    });
    await expect(securityEventsApi.list()).rejects.toThrow(
      "failed to list security events",
    );
  });
});
