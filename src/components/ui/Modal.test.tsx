import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Modal from "./Modal";

describe("Modal (mac panel)", () => {
  it("renders a 10px-radius bordered panel with a labeled close button", () => {
    const html = renderToStaticMarkup(
      <Modal title="Add Host" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(html).toContain("rounded-[10px]");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("bg-black/30");
  });
});
