import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContextMenu from "./ContextMenu";

const render = (danger: boolean) =>
  renderToStaticMarkup(
    <ContextMenu
      items={[{ label: "Delete", danger, onClick: () => {} }]}
      x={0}
      y={0}
      onClose={() => {}}
    />,
  );

describe("ContextMenu highlight", () => {
  // --color-white is the theme's text color; on accent fills light themes
  // need the paired *-text token to stay readable.
  it("uses the accent's paired text color on the highlighted row", () => {
    expect(render(false)).toContain("bg-primary-600 text-primary-text");
    expect(render(true)).toContain("bg-danger-600 text-danger-text");
    expect(render(false)).not.toContain("text-white bg-primary-600");
  });
});
