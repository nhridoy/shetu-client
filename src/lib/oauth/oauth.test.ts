import { describe, expect, it } from "vitest";
import { parseCallbackUrl } from "./oauth";

describe("parseCallbackUrl", () => {
  it("parses a two-factor callback", () => {
    expect(
      parseCallbackUrl(
        "http://127.0.0.1:1421/oauth/callback?dest=two_factor&challenge=ch-1&user_id=u-1",
      ),
    ).toEqual({ dest: "two_factor", challenge: "ch-1", userId: "u-1" });
    expect(
      parseCallbackUrl(
        "http://127.0.0.1:1421/oauth/callback?dest=two_factor&user_id=u-1",
      ).dest,
    ).toBe("error");
  });

  it("parses a setup callback", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1421/oauth/callback?dest=setup&setup_code=abc123&user_id=u-1",
    );
    expect(result).toEqual({
      dest: "setup",
      setupCode: "abc123",
      userId: "u-1",
    });
  });

  it("parses a success callback with tokens", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1422/oauth/callback?dest=success&access_token=eyJ0&refresh_token=eyJ1&user_id=u-1",
    );
    expect(result).toEqual({
      dest: "success",
      accessToken: "eyJ0",
      refreshToken: "eyJ1",
      userId: "u-1",
    });
  });

  it("parses an error callback with a message", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1423/oauth/callback?dest=error&message=access_denied",
    );
    expect(result).toEqual({
      dest: "error",
      message: "access_denied",
    });
  });

  it("returns an error for a setup callback missing params", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1421/oauth/callback?dest=setup",
    );
    expect(result.dest).toBe("error");
  });

  it("returns an error for a success callback missing tokens", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1421/oauth/callback?dest=success&user_id=u-1",
    );
    expect(result.dest).toBe("error");
  });

  it("returns an error for an unknown dest", () => {
    const result = parseCallbackUrl(
      "http://127.0.0.1:1421/oauth/callback?dest=weird",
    );
    expect(result.dest).toBe("error");
  });

  it("returns an error for an invalid URL", () => {
    const result = parseCallbackUrl("not a url");
    expect(result.dest).toBe("error");
  });
});
