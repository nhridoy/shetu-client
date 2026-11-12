import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T05:03:09.325Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("formats the ISO timestamps the local database stores", () => {
    expect(formatRelativeTime("2026-11-13T05:02:30.000Z")).toBe("just now");
    expect(formatRelativeTime("2026-11-13T03:03:09.325Z")).toBe("2h ago");
    expect(formatRelativeTime("2026-11-06T05:03:09.325Z")).toBe("7d ago");
    expect(formatRelativeTime("2024-11-13T05:03:09.325Z")).toBe("2y ago");
  });

  it("shows nothing for an unparseable timestamp instead of 'NaNy ago'", () => {
    expect(formatRelativeTime("")).toBe("");
    expect(formatRelativeTime("not a date")).toBe("");
  });
});
