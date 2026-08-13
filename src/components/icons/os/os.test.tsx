import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OS_META, osMeta } from "@/lib/constants/os";
import PlaceholderOsIcon from "./PlaceholderOsIcon";

describe("os icons", () => {
  it("every OS_META entry renders non-empty svg markup", () => {
    for (const [key, meta] of Object.entries(OS_META)) {
      const html = renderToStaticMarkup(
        createElement(meta.Icon, { className: "w-3" }),
      );
      expect(html.length, `icon ${key} renders`).toBeGreaterThan(0);
    }
  });

  it("unknown os falls back to the placeholder", () => {
    expect(osMeta("truenas").Icon).toBe(PlaceholderOsIcon);
    expect(osMeta(undefined).name).toBe("Unknown");
    expect(osMeta("UBUNTU").Icon).toBe(OS_META.ubuntu.Icon);
  });
});
