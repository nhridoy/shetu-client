// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { askSnippetVariables } from "@/stores/snippets/snippetVariablesStore";
import SnippetVariablesDialog from "./SnippetVariablesDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount() {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () => root.render(<SnippetVariablesDialog />));
  return root;
}

const field = (name: string) =>
  document.querySelector(`input[name="${name}"]`) as HTMLInputElement;

function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const submit = () =>
  act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("SnippetVariablesDialog", () => {
  it("asks for each variable and resolves the values", async () => {
    const root = await mount();
    let answer: Promise<Record<string, string> | null> = Promise.resolve(null);
    await act(async () => {
      answer = askSnippetVariables(["lines", "service"]);
    });
    expect(document.body.textContent).toContain("Fill in snippet");
    type(field("lines"), "50");
    type(field("service"), "nginx");
    await submit();
    expect(await answer).toEqual({ lines: "50", service: "nginx" });
    expect(document.body.textContent).not.toContain("Fill in snippet");
    act(() => root.unmount());
  });

  it("prefills the values used last time this session", async () => {
    const root = await mount();
    let answer: Promise<Record<string, string> | null> = Promise.resolve(null);
    await act(async () => {
      answer = askSnippetVariables(["service"]);
    });
    expect(field("service").value).toBe("nginx");
    await submit();
    expect(await answer).toEqual({ service: "nginx" });
    act(() => root.unmount());
  });

  it("Cancel resolves null", async () => {
    const root = await mount();
    let answer: Promise<Record<string, string> | null> = Promise.resolve({});
    await act(async () => {
      answer = askSnippetVariables(["x"]);
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Cancel")
        ?.click();
    });
    expect(await answer).toBeNull();
    act(() => root.unmount());
  });
});
