// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NewTarget, useNewParam } from "./useNewParam";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
function Probe({
  handlers,
}: {
  handlers: Partial<Record<NewTarget, () => void>>;
}) {
  useNewParam(handlers);
  search = useLocation().search;
  return null;
}

function mount(url: string, handlers: Partial<Record<NewTarget, () => void>>) {
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Probe handlers={handlers} />
      </MemoryRouter>,
    ),
  );
  return root;
}

afterEach(() => {
  search = "";
});

describe("useNewParam", () => {
  it("opens the form once and clears the param", () => {
    const host = vi.fn();
    const root = mount("/hosts?new=host", { host });
    expect(host).toHaveBeenCalledTimes(1);
    expect(search).toBe("");
    act(() => root.unmount());
  });

  it("leaves a value the page doesn't own alone", () => {
    const host = vi.fn();
    const root = mount("/hosts?new=key", { host });
    expect(host).not.toHaveBeenCalled();
    expect(search).toBe("?new=key");
    act(() => root.unmount());
  });

  it("ignores inherited names like __proto__", () => {
    const host = vi.fn();
    const root = mount("/hosts?new=__proto__", { host });
    expect(host).not.toHaveBeenCalled();
    expect(search).toBe("?new=__proto__");
    act(() => root.unmount());
  });
});
