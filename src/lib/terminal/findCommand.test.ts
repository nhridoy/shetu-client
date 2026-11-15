// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { onOpenFind, openFind } from "./findCommand";

describe("findCommand", () => {
  it("openFind reaches subscribers until they unsubscribe", () => {
    const handler = vi.fn();
    const off = onOpenFind(handler);
    openFind();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    openFind();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
