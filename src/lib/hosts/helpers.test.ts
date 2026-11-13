import { describe, expect, it } from "vitest";
import type { Group } from "@/stores/hosts/hostStore";
import { filterHosts, openGroupId, tagCounts } from "./helpers";

const groups = [{ id: "servers" }, { id: "db" }] as Group[];

describe("openGroupId", () => {
  it("keeps the open group while it exists", () => {
    expect(openGroupId(groups, "db")).toBe("db");
  });

  it("falls back to the top level when the open group is gone", () => {
    // e.g. deleted on another device and removed by sync
    expect(openGroupId(groups, "deleted-elsewhere")).toBeNull();
  });

  it("stays at the top level when nothing is open", () => {
    expect(openGroupId(groups, null)).toBeNull();
  });
});

const h = (
  name: string,
  address: string,
  tags: string[],
  username?: string,
) => ({
  name,
  address,
  tags,
  username,
});
const hosts = [
  h("prod-eu-1", "10.0.4.12", ["prod", "api"], "deploy"),
  h("db-01", "10.0.4.30", ["prod", "db"], "postgres"),
  h("staging-api", "staging.example.com", ["staging", "api"]),
  h("telehack.com", "telehack.com", []),
];
const names = (list: typeof hosts) => list.map((x) => x.name);

describe("filterHosts", () => {
  it("returns everything with no query and no tags", () => {
    expect(filterHosts(hosts, "", new Set())).toEqual(hosts);
  });

  it("matches name or tag, case-insensitively", () => {
    expect(names(filterHosts(hosts, "DB", new Set()))).toEqual(["db-01"]);
    expect(names(filterHosts(hosts, "  staging ", new Set()))).toEqual([
      "staging-api",
    ]);
  });

  it("ignores address and user, which list-state hosts keep encrypted", () => {
    expect(filterHosts(hosts, "10.0.4", new Set())).toEqual([]);
    expect(filterHosts(hosts, "postgres", new Set())).toEqual([]);
  });

  it("keeps a host that has any selected tag", () => {
    expect(names(filterHosts(hosts, "", new Set(["db", "staging"])))).toEqual([
      "db-01",
      "staging-api",
    ]);
  });

  it("applies the query and the tags together", () => {
    expect(names(filterHosts(hosts, "api", new Set(["prod"])))).toEqual([
      "prod-eu-1",
    ]);
  });
});

describe("tagCounts", () => {
  it("counts each tag once per host, sorted by tag", () => {
    expect(tagCounts([...hosts, h("dup", "x", ["api", "api"])])).toEqual([
      ["api", 3],
      ["db", 1],
      ["prod", 2],
      ["staging", 1],
    ]);
  });
});
