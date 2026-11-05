import { describe, expect, it } from "vitest";
import type { Group } from "@/stores/hosts/hostStore";
import { openGroupId } from "./helpers";

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
