import { describe, expect, it } from "vitest";
import {
  deriveAuthType,
  loadedCredentials,
  ownCredentials,
} from "./credentials";

const host = (groupId: string | null = null, stored?: string, touched = true) =>
  ({ mode: "host", groupId, stored, touched }) as const;

describe("deriveAuthType", () => {
  it("follows what is filled", () => {
    expect(deriveAuthType({ identityId: "i1", password: "p" }, host())).toBe(
      "identity",
    );
    expect(deriveAuthType({ password: "p", keyId: "k" }, host())).toBe("both");
    expect(deriveAuthType({ password: "p" }, host())).toBe("password");
    expect(deriveAuthType({ keyId: "k" }, host())).toBe("key");
  });

  it("nothing filled: inherit in a group, none without, not set for groups", () => {
    expect(deriveAuthType({}, host("g1"))).toBe("inherit");
    expect(deriveAuthType({ password: "" }, host())).toBe("none");
    expect(
      deriveAuthType({}, { mode: "group", groupId: null, touched: true }),
    ).toBe("");
  });

  it("untouched none stays none", () => {
    expect(deriveAuthType({}, host("g1", "none", false))).toBe("none");
    expect(deriveAuthType({}, host("g1", "none", true))).toBe("inherit");
  });
});

describe("loadedCredentials", () => {
  it("loads only the fields the stored method uses", () => {
    expect(loadedCredentials("key", { password: "old", keyId: "k" })).toEqual({
      password: "",
      keyId: "k",
      identityId: "",
    });
    expect(
      loadedCredentials("identity", { identityId: "i", password: "p" }),
    ).toEqual({ password: "", keyId: "", identityId: "i" });
    expect(
      loadedCredentials("both", { password: "p", keyId: "k", identityId: "i" }),
    ).toEqual({ password: "p", keyId: "k", identityId: "" });
    expect(loadedCredentials(undefined, { password: "p" })).toEqual({
      password: "",
      keyId: "",
      identityId: "",
    });
  });

  it("ownCredentials", () => {
    expect(ownCredentials({})).toBe(false);
    expect(ownCredentials({ password: "", keyId: "k" })).toBe(true);
  });
});
