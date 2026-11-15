// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import TerminalFindBar, { type FindTarget } from "./TerminalFindBar";

let opened = 0;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let emit: (e: { resultIndex: number; resultCount: number }) => void;
type FindFn = (term: string, options?: unknown) => boolean;
let search: FindTarget & {
  findNext: Mock<FindFn>;
  findPrevious: Mock<FindFn>;
  clearDecorations: Mock<() => void>;
};
let onClose: Mock<() => void>;

const text = () => document.body.textContent ?? "";
const field = () => document.querySelector("input") as HTMLInputElement;
const byLabel = (label: string) =>
  document.querySelector(
    `[aria-label="${label}"], [title="${label}"]`,
  ) as HTMLElement;

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (k: string, shift = false) =>
  act(() => {
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }),
    );
  });

async function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root?.render(
      <TerminalFindBar search={search} onClose={onClose} opened={opened} />,
    ),
  );
}

beforeEach(() => {
  search = {
    findNext: vi.fn<FindFn>(() => true),
    findPrevious: vi.fn<FindFn>(() => true),
    clearDecorations: vi.fn<() => void>(),
    onDidChangeResults: (listener) => {
      emit = listener;
      return { dispose: () => {} };
    },
  };
  onClose = vi.fn<() => void>();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("TerminalFindBar", () => {
  it("searches as you type with highlights", async () => {
    await render();
    type("error");
    expect(search.findNext).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        incremental: true,
        decorations: expect.objectContaining({
          matchBackground: "#f59e0b55",
          activeMatchBackground: "#f59e0b",
        }),
      }),
    );
  });

  it("shows N of M, or No results", async () => {
    await render();
    type("error");
    act(() => emit({ resultIndex: 2, resultCount: 12 }));
    expect(text()).toContain("3 of 12");
    act(() => emit({ resultIndex: -1, resultCount: 0 }));
    expect(text()).toContain("No results");
  });

  it("Enter goes to the next match, Shift+Enter to the previous", async () => {
    await render();
    type("error");
    search.findNext.mockClear();
    key("Enter");
    expect(search.findNext).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ incremental: false }),
    );
    key("Enter", true);
    expect(search.findPrevious).toHaveBeenCalledWith(
      "error",
      expect.anything(),
    );
    act(() => byLabel("Next match").click());
    act(() => byLabel("Previous match").click());
    expect(search.findNext).toHaveBeenCalledTimes(2);
    expect(search.findPrevious).toHaveBeenCalledTimes(2);
  });

  it("toggles flip their search options", async () => {
    await render();
    type("Err");
    act(() => byLabel("Match case").click());
    act(() => byLabel("Whole word").click());
    act(() => byLabel("Use regex").click());
    expect(search.findNext).toHaveBeenLastCalledWith(
      "Err",
      expect.objectContaining({
        caseSensitive: true,
        wholeWord: true,
        regex: true,
      }),
    );
    expect(byLabel("Use regex").getAttribute("aria-pressed")).toBe("true");
  });

  it("invalid regex shows Invalid pattern", async () => {
    await render();
    act(() => byLabel("Use regex").click());
    search.findNext.mockImplementation(() => {
      throw new SyntaxError("bad");
    });
    type("(");
    expect(text()).toContain("Invalid pattern");
    expect(search.clearDecorations).toHaveBeenCalled();
  });

  it("Escape closes and clears", async () => {
    await render();
    type("error");
    key("Escape");
    expect(search.clearDecorations).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("empty query clears", async () => {
    await render();
    type("error");
    act(() => emit({ resultIndex: 0, resultCount: 3 }));
    search.findNext.mockClear();
    type("");
    expect(search.findNext).not.toHaveBeenCalled();
    expect(search.clearDecorations).toHaveBeenCalled();
    expect(text()).not.toContain("of 3");
  });

  it("Escape closes from the toggle buttons too", async () => {
    await render();
    act(() => {
      byLabel("Match case").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows 1000+ past the highlight limit", async () => {
    await render();
    type("x");
    act(() => emit({ resultIndex: -1, resultCount: 1000 }));
    expect(text()).toContain("1000+ matches");
  });

  it("the shortcut again refocuses the open bar", async () => {
    await render();
    (
      document.body.appendChild(document.createElement("button")) as HTMLElement
    ).focus();
    opened += 1;
    await act(async () =>
      root?.render(
        <TerminalFindBar search={search} onClose={onClose} opened={opened} />,
      ),
    );
    expect(document.activeElement).toBe(field());
  });

  it("reopening keeps the last query", async () => {
    await render();
    type("needle");
    await act(async () => root?.unmount());
    root = undefined;
    await render();
    expect(field().value).toBe("needle");
  });
});
