// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  run: vi.fn(async (): Promise<string> => "ok"),
  update: vi.fn(async () => {}),
  decrypt: vi.fn(
    async (): Promise<{ command: string; targets: string[] }> => ({
      command: "ls",
      targets: ["h2"],
    }),
  ),
  storeError: null as string | null,
  error: vi.fn(),
}));
vi.mock("@/lib/snippets/runOnHosts", () => ({ runOnHosts: m.run }));
vi.mock("sonner", () => ({ toast: { error: m.error, success: vi.fn() } }));
vi.mock("@/stores/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({
      getDecryptedSnippet: m.decrypt,
      updateSnippet: m.update,
      error: m.storeError,
    }),
  },
}));
vi.mock("@/stores/hosts/hostStore", () => {
  const state = {
    hosts: [
      { id: "h1", name: "web-1" },
      { id: "h2", name: "db-1" },
    ],
  };
  return {
    useHostStore: Object.assign(
      (pick: (s: unknown) => unknown) => pick(state),
      { getState: () => state },
    ),
  };
});

import RunOnHostsDialog from "./RunOnHostsDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const onClose = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  m.storeError = null;
});
afterEach(() => {
  document.body.innerHTML = "";
});

async function render() {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/snippets"]}>
        <Routes>
          <Route
            path="/snippets"
            element={
              <RunOnHostsDialog
                snippet={{ id: "s1", name: "List" }}
                onClose={onClose}
              />
            }
          />
          <Route path="/terminal" element={<p>terminal view</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  return root;
}

const box = (name: string) =>
  [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.includes(name))
    ?.querySelector("input") as HTMLInputElement;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label);

describe("RunOnHostsDialog", () => {
  it("preselects saved targets and filters by search", async () => {
    await render();
    expect(box("db-1").checked).toBe(true);
    expect(box("web-1").checked).toBe(false);
    const search = document.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "web");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(box("db-1")).toBeUndefined();
    expect(box("web-1")).toBeDefined();
  });

  it("hosts can't be picked until the saved targets load", async () => {
    let finish: (v: { command: string; targets: string[] }) => void = () => {};
    m.decrypt.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await render();
    expect(box("web-1").disabled).toBe(true);
    expect(button("Run")?.disabled).toBe(true);
    // Saving now would replace the stored targets with an empty list.
    expect(button("Save targets")?.disabled).toBe(true);
    await act(async () => finish({ command: "ls", targets: ["h2"] }));
    expect(box("web-1").disabled).toBe(false);
    expect(box("db-1").checked).toBe(true);
  });

  it("Save targets stores the selection", async () => {
    await render();
    act(() => box("web-1").click());
    await act(async () => button("Save targets")?.click());
    expect(m.update).toHaveBeenCalledWith("s1", { targets: ["h2", "h1"] });
  });

  it("Run runs on the picked hosts and goes to the terminal", async () => {
    await render();
    await act(async () => button("Run")?.click());
    expect(m.run).toHaveBeenCalledWith("s1", ["h2"]);
    expect(onClose).toHaveBeenCalled();
    expect(document.body.textContent).toContain("terminal view");
  });

  it("Run with nothing picked asks for a host", async () => {
    m.decrypt.mockResolvedValueOnce({ command: "ls", targets: [] });
    await render();
    await act(async () => button("Run")?.click());
    expect(m.run).not.toHaveBeenCalled();
    expect(m.error).toHaveBeenCalledWith("Pick at least one host");
  });

  it("Enter in the search box doesn't run anything", async () => {
    await render();
    const search = document.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    act(() => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await act(async () => {});
    expect(m.run).not.toHaveBeenCalled();
  });

  it("saved ids of deleted hosts don't count as selected", async () => {
    m.decrypt.mockResolvedValueOnce({ command: "ls", targets: ["h2", "gone"] });
    await render();
    expect(document.querySelector("[aria-live]")?.textContent).toContain(
      "1 selected",
    );
  });

  it("a failed save says so", async () => {
    m.storeError = "db locked";
    await render();
    await act(async () => button("Save targets")?.click());
    expect(m.error).toHaveBeenCalledWith("Couldn't save targets");
  });

  it("a cancelled variables form keeps the dialog open", async () => {
    m.run.mockResolvedValueOnce("cancelled");
    await render();
    await act(async () => button("Run")?.click());
    expect(onClose).not.toHaveBeenCalled();
  });
});
