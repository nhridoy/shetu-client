import { describe, expect, it } from "vitest";
import { buttonVariants } from "./Button";

describe("buttonVariants (mac values)", () => {
  it("uses mac heights and the arrow cursor", () => {
    expect(buttonVariants()).toContain("h-7");
    expect(buttonVariants()).toContain("cursor-default");
    expect(buttonVariants()).toContain("rounded-md");
    expect(buttonVariants({ size: "icon-xs" })).toContain("h-5 w-5");
  });

  it("uses a solid 2px focus ring (>=3:1 in light themes) without offset", () => {
    const cls = buttonVariants();
    expect(cls).toContain(
      "focus-visible:ring-2 focus-visible:ring-primary-500 ",
    );
    expect(cls).not.toContain("ring-primary-500/");
    expect(cls).not.toContain("ring-offset-2");
  });
});
