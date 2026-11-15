// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, type NavigateFunction, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/snippets/lists/SnippetList", () => ({
  default: ({ onEdit }: { onEdit: (s: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onEdit({ id: "s1", name: "deploy", tags: [] })}
    >
      edit deploy
    </button>
  ),
}));
vi.mock("@/components/snippets/forms/SnippetForm", () => ({
  default: ({ snippet }: { snippet?: { name: string } }) => (
    <p data-testid="form">{snippet ? `editing ${snippet.name}` : "new"}</p>
  ),
}));

import SnippetsPage from "./SnippetsPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

let navigate: NavigateFunction = () => {};
function Nav() {
  navigate = useNavigate();
  return null;
}

describe("SnippetsPage", () => {
  it("New snippet from the palette keeps an open edit", () => {
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/snippets"]}>
          <Nav />
          <SnippetsPage />
        </MemoryRouter>,
      ),
    );
    act(() => document.querySelector("button")?.click());
    act(() => {
      void navigate("/snippets?new=snippet");
    });
    expect(document.querySelector('[data-testid="form"]')?.textContent).toBe(
      "editing deploy",
    );
    act(() => root.unmount());
  });
});
