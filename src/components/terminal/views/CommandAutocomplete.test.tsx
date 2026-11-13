// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/snippets/snippetStore", () => ({
  useSnippetStore: () => ({
    snippets: [
      {
        id: "s1",
        name: "Restart API",
        command: "",
        description: "restarts the api",
        tags: ["deploy"],
        createdAt: "",
      },
    ],
  }),
}));

import CommandAutocomplete from "./CommandAutocomplete";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

function render(
  platform = "Linux x86_64",
  onSelectImpl: (...a: unknown[]) => unknown = () => {},
) {
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
  const onSelect = vi.fn(onSelectImpl);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <CommandAutocomplete isVisible onSelect={onSelect} onClose={() => {}} />,
    ),
  );
  const input = container.querySelector("input") as HTMLInputElement;
  const key = (init: KeyboardEventInit) =>
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
    });
  const type = (value: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { container, onSelect, key, type, root };
}

describe("CommandAutocomplete", () => {
  it("enter_inserts the highlighted snippet", () => {
    const { onSelect, key } = render();
    key({ key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      { snippetId: "s1", command: "" },
      false,
    );
  });

  it("ctrl_enter_runs on Linux/Windows", () => {
    const { onSelect, key } = render();
    key({ key: "Enter", ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith(
      { snippetId: "s1", command: "" },
      true,
    );
  });

  it("run_modifier_follows_platform on macOS", () => {
    const { onSelect, key } = render("MacIntel");
    key({ key: "Enter", ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(expect.anything(), false);
    key({ key: "Enter", metaKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("click_inserts", () => {
    const { container, onSelect } = render();
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Restart API"),
    );
    act(() => row?.click());
    expect(onSelect).toHaveBeenCalledWith(
      { snippetId: "s1", command: "" },
      false,
    );
  });

  it("search_matches_tags", () => {
    const { container, type } = render();
    type("deploy");
    expect(container.textContent).toContain("Restart API");
    type("nothing-matches-this");
    expect(container.textContent).not.toContain("Restart API");
  });

  it("footer_hint_shown with the platform modifier", () => {
    expect(render().container.textContent).toContain(
      "Enter to insert · Ctrl+Enter to run",
    );
    expect(render("MacIntel").container.textContent).toContain(
      "Enter to insert · Cmd+Enter to run",
    );
  });

  it("selection_never_goes_past_the_visible_rows", () => {
    const { onSelect, key } = render();
    for (let i = 0; i < 15; i++) key({ key: "ArrowDown" });
    key({ key: "Enter" });
    // 10 rows are shown: the snippet, then built-ins; the 10th is "chown ".
    expect(onSelect).toHaveBeenCalledWith({ command: "chown " }, false);
  });

  it("typing_resets_the_selection", () => {
    const { onSelect, key, type } = render();
    for (let i = 0; i < 3; i++) key({ key: "ArrowDown" });
    type("deploy");
    key({ key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      { snippetId: "s1", command: "" },
      false,
    );
  });

  it("a_second_pick_is_ignored_while_the_first_is_running", () => {
    const { onSelect, key } = render(
      "Linux x86_64",
      () => new Promise(() => {}),
    );
    key({ key: "Enter", ctrlKey: true });
    key({ key: "Enter", ctrlKey: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("enter_confirming_an_ime_candidate_does_not_pick", () => {
    const { onSelect, key } = render();
    key({ key: "Enter", isComposing: true });
    key({ key: "Enter", keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
