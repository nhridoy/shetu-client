// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/snippets/RunOnHostsDialog", () => ({
  default: () => <p>host picker</p>,
}));

import { useSnippetStore } from "@/stores/snippets/snippetStore";
import SnippetList from "./SnippetList";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("SnippetList", () => {
  it("Enter on the Run on hosts button opens the picker, not the editor", async () => {
    useSnippetStore.setState({
      snippets: [
        { id: "s1", name: "Deploy", command: "", tags: [], createdAt: "1" },
      ],
      fetchSnippets: vi.fn(async () => {}),
      getDecryptedSnippet: vi.fn(async () => null),
    } as never);
    const onEdit = vi.fn();
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SnippetList onNew={() => {}} onEdit={onEdit} />
        </MemoryRouter>,
      ),
    );
    const run = document.querySelector('[title="Run on hosts"]') as HTMLElement;
    await act(async () => {
      run.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      run.click();
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("host picker");
    act(() => root.unmount());
  });
});
