import { describe, expect, it } from "vitest";
import { hostFormDefaultValues, hostFormSchema } from "./hostFormSchema";

const base = {
  ...hostFormDefaultValues,
  name: "h",
  address: "a",
  username: "u",
  password: "pw",
};

const issuePaths = (input: object) => {
  const r = hostFormSchema.safeParse({ ...base, ...input });
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("hostFormSchema connection options", () => {
  it("keepalive: empty and 0 are valid, 3 and 601 are not, 5 is", () => {
    expect(issuePaths({ keepaliveSecs: "" })).toEqual([]);
    expect(issuePaths({ keepaliveSecs: 0 })).toEqual([]);
    expect(issuePaths({ keepaliveSecs: 3 })).toContain("keepaliveSecs");
    expect(issuePaths({ keepaliveSecs: 601 })).toContain("keepaliveSecs");
    expect(issuePaths({ keepaliveSecs: 5 })).toEqual([]);
  });

  it("only address is required", () => {
    expect(
      issuePaths({ name: "", port: "", username: "", password: "pw" }),
    ).toEqual([]);
    expect(issuePaths({ address: "" })).toEqual(["address"]);
  });

  it("port must be 1-65535 when present", () => {
    expect(issuePaths({ port: 0 })).toContain("port");
    expect(issuePaths({ port: 70000 })).toContain("port");
    expect(issuePaths({ port: "22" })).toEqual([]);
  });

  it("rejects invalid env names", () => {
    expect(issuePaths({ env: [{ name: "1X", value: "" }] }).length).toBe(1);
    expect(issuePaths({ env: [{ name: "LANG", value: "C" }] })).toEqual([]);
    expect(issuePaths({ env: [{ name: "", value: "" }] })).toEqual([]);
  });

  it("snippet startup needs a snippet", () => {
    expect(issuePaths({ startupMode: "snippet" })).toContain(
      "startupSnippetId",
    );
    expect(
      issuePaths({ startupMode: "snippet", startupSnippetId: "s1" }),
    ).toEqual([]);
  });
});

describe("hostFormSchema group inheritance", () => {
  it("accepts authType inherit with no password or key", () => {
    expect(
      issuePaths({
        authType: "inherit",
        password: "",
        keyId: "",
        groupId: "g1",
      }),
    ).toEqual([]);
  });

  it("inherit needs a group", () => {
    expect(issuePaths({ authType: "inherit", groupId: "" })).toContain(
      "authType",
    );
  });

  it("username may be empty", () => {
    expect(issuePaths({ username: " " })).toEqual([]);
  });

  it("accepts the tri-state startup and forwarding modes", () => {
    expect(
      issuePaths({ startupMode: "inherit", forwardAgentMode: "inherit" }),
    ).toEqual([]);
  });
});

describe("hostFormSchema identity", () => {
  it("Identity needs an identity picked", () => {
    expect(issuePaths({ authType: "identity", identityId: "" })).toContain(
      "identityId",
    );
    expect(issuePaths({ authType: "identity", identityId: "i1" })).toEqual([]);
  });
});
