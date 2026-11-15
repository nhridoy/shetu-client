// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, type NavigateFunction, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/keys/keyStore", () => {
  const state = {
    keys: [],
    fetchKeys: vi.fn(),
    deleteKey: vi.fn(),
  };
  return {
    useKeyStore: (pick: (s: typeof state) => unknown) => pick(state),
  };
});
vi.mock("@/stores/vault/vaultStore", () => ({
  useVaultStore: () => ({ currentVaultId: null }),
}));
vi.mock("@/components/keys/modals/GenerateKeyModal", () => ({
  default: () => <div data-testid="generate-key">generate</div>,
}));
vi.mock("@/components/keys/modals/ImportKeyModal", () => ({
  default: () => null,
}));
vi.mock("@/components/identities/IdentityList", () => ({
  default: () => <p>identities</p>,
}));

import KeysPage from "./KeysPage";

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

describe("KeysPage", () => {
  it("New key from the palette shows the Keys tab with the form", () => {
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/keys"]}>
          <Nav />
          <KeysPage />
        </MemoryRouter>,
      ),
    );
    const tab = (name: string) =>
      [...document.querySelectorAll('[role="tab"]')].find(
        (t) => t.textContent === name,
      ) as HTMLElement;
    act(() => tab("Identities").click());
    act(() => {
      void navigate("/keys?new=key");
    });
    const modal = document.querySelector('[data-testid="generate-key"]');
    expect(modal).not.toBeNull();
    expect(modal?.closest("[hidden]")).toBeNull();
    expect(tab("Keys").getAttribute("aria-selected")).toBe("true");
    act(() => root.unmount());
  });
});
