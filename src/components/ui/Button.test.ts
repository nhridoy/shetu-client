import { describe, expect, it } from "vitest";
import { buttonVariants } from "./Button";

describe("buttonVariants (mac values)", () => {
  it("uses mac heights and the arrow cursor", () => {
    expect(buttonVariants()).toContain("h-7");
    expect(buttonVariants()).toContain("cursor-default");
    expect(buttonVariants()).toContain("rounded-md");
    expect(buttonVariants({ size: "icon-xs" })).toContain("h-5 w-5");
  });

  it("uses a soft 3px focus ring without offset", () => {
    const cls = buttonVariants();
    expect(cls).toContain("focus-visible:ring-[3px]");
    expect(cls).toContain("focus-visible:ring-primary-500/50");
    expect(cls).not.toContain("ring-offset-2");
  });
});
