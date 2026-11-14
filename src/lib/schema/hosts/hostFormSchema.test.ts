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
  it("rejects custom keepalive outside 5-600", () => {
    expect(issuePaths({ keepaliveMode: "custom", keepaliveSecs: 3 })).toContain(
      "keepaliveSecs",
    );
    expect(
      issuePaths({ keepaliveMode: "custom", keepaliveSecs: 601 }),
    ).toContain("keepaliveSecs");
    expect(issuePaths({ keepaliveMode: "custom", keepaliveSecs: 5 })).toEqual(
      [],
    );
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
