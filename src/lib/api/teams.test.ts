import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({ httpRequest: vi.fn() }));

import { httpRequest } from "./http";
import { type TeamApiError, teamsApi } from "./teams";

const request = vi.mocked(httpRequest);

beforeEach(() => request.mockReset());

describe("teams API", () => {
  it("returns typed team data from the API envelope", async () => {
    request.mockResolvedValue({
      status: 200,
      body: '{"data":[{"id":"team-1","name":"Ops"}]}',
    });
    await expect(teamsApi.listTeams()).resolves.toEqual([
      { id: "team-1", name: "Ops" },
    ]);
    expect(request).toHaveBeenCalledWith("GET", "/api/v1/teams", undefined);
  });

  it("keeps server validation failures visible to the caller", async () => {
    request.mockResolvedValue({
      status: 409,
      body: '{"error":{"code":"KEY_CHANGED","message":"recipient identity key changed"}}',
    });
    await expect(
      teamsApi.invite("team-1", {
        email: "a@example.com",
        role: "member",
        recipient_fingerprint: "fp",
        envelopes: [],
      }),
    ).rejects.toMatchObject({
      name: "TeamApiError",
      status: 409,
      code: "KEY_CHANGED",
      message: "recipient identity key changed",
    } satisfies Partial<TeamApiError>);
  });
});
