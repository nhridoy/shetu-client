// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
}

const pressEscape = () =>
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

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

  it("escape_closes_only_the_top_dialog", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    mount(
      <Modal title="Settings" onClose={outer}>
        <Modal title="Delete" onClose={inner}>
          body
        </Modal>
      </Modal>,
    );
    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("escape_closes_nothing_while_the_top_dialog_is_busy", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    mount(
      <Modal title="Settings" onClose={outer}>
        <Modal title="Delete" onClose={inner} hideClose>
          body
        </Modal>
      </Modal>,
    );
    pressEscape();
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  it("escape_reaches_the_outer_dialog_after_the_inner_one_closes", () => {
    const outer = vi.fn();
    const tree = (inner: boolean) => (
      <Modal title="Settings" onClose={outer}>
        {inner && (
          <Modal title="Delete" onClose={() => {}}>
            body
          </Modal>
        )}
      </Modal>
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(tree(true)));
    act(() => root.render(tree(false)));
    pressEscape();
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
