// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import KeysPage from "@/pages/KeysPage";
import { useIdentityStore } from "@/stores/identities/identityStore";
import { useKeyStore } from "@/stores/keys/keyStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import IdentityList, { usageMessage } from "./IdentityList";
import IdentityModal from "./IdentityModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const text = () => document.body.textContent ?? "";
let root: Root | undefined;

function setValue(el: Element | null, value: string) {
  if (!el) throw new Error("missing input");
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const input = (name: string) => document.querySelector(`input[name="${name}"]`);

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.title === label,
  );

async function render(node: React.ReactNode) {
  const created = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  root = created;
  await act(async () => created.render(<MemoryRouter>{node}</MemoryRouter>));
}

const identity = {
  id: "i1",
  name: "deploy@prod",
  vaultId: "v1",
  sortOrder: 0,
  createdAt: "1",
};

const createIdentity = vi.fn(async () => "new-id");
const updateIdentity = vi.fn(async () => true);
const deleteIdentity = vi.fn(async () => {});
const getDecryptedIdentity = vi.fn(async () => ({
  username: "deploy",
  hasPassword: true,
  hasTotp: true,
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.invoke.mockReset();
  h.invoke.mockResolvedValue([]);
  useVaultStore.setState({ currentVaultId: "v1" });
  useKeyStore.setState({ keys: [], fetchKeys: vi.fn(async () => true) });
  useIdentityStore.setState({
    identities: [],
    fetchIdentities: vi.fn(async () => {}),
    createIdentity,
    updateIdentity,
    deleteIdentity,
    getDecryptedIdentity,
  });
  vi.clearAllMocks();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("IdentityModal", () => {
  it("requires a label and a username", async () => {
    await render(<IdentityModal onClose={() => {}} onSaved={() => {}} />);
    await act(async () => button("Save")?.click());
    expect(text()).toContain("Label is required");
    expect(text()).toContain("Username is required");
    expect(createIdentity).not.toHaveBeenCalled();
  });

  it("creates and reports the new id", async () => {
    const onSaved = vi.fn();
    await render(<IdentityModal onClose={() => {}} onSaved={onSaved} />);
    await act(async () => {
      setValue(input("name"), "deploy@prod");
      setValue(input("username"), "deploy");
      setValue(input("password"), "pw");
    });
    await act(async () => button("Save")?.click());
    expect(createIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deploy@prod",
        username: "deploy",
        password: "pw",
        vaultId: "v1",
      }),
    );
    expect(onSaved).toHaveBeenCalledWith("new-id");
  });

  it("editing waits for the stored identity before Save works", async () => {
    let resolve: (v: unknown) => void = () => {};
    getDecryptedIdentity.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)) as never,
    );
    await render(
      <IdentityModal
        identity={identity}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(button("Save")?.disabled).toBe(true);
    await act(async () =>
      resolve({ username: "deploy", hasPassword: false, hasTotp: false }),
    );
    expect(button("Save")?.disabled).toBe(false);
  });

  it("an identity that can't be loaded can't be saved", async () => {
    getDecryptedIdentity.mockResolvedValueOnce(null as never);
    await render(
      <IdentityModal
        identity={identity}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(button("Save")?.disabled).toBe(true);
    expect(text()).toContain("Couldn't load this identity");
  });

  it("closes when the vault changes", async () => {
    const onClose = vi.fn();
    await render(<IdentityModal onClose={onClose} onSaved={() => {}} />);
    await act(async () => useVaultStore.setState({ currentVaultId: "v2" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("editing with an empty password keeps the stored one", async () => {
    await render(
      <IdentityModal
        identity={identity}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect((input("username") as HTMLInputElement).value).toBe("deploy");
    expect((input("password") as HTMLInputElement).placeholder).toBe(
      "Leave empty to keep",
    );
    await act(async () => button("Save")?.click());
    expect(updateIdentity).toHaveBeenCalledWith(
      "i1",
      expect.objectContaining({
        username: "deploy",
        password: "",
        totpSecret: "",
      }),
    );
  });

  it("previews the code for a pasted otpauth URI", async () => {
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "totp_preview" ? { code: "287082", secondsLeft: 29 } : [],
    );
    await render(<IdentityModal onClose={() => {}} onSaved={() => {}} />);
    await act(async () =>
      setValue(input("totpSecret"), "otpauth://totp/x?secret=GEZDGNBV"),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(h.invoke).toHaveBeenCalledWith("totp_preview", {
      value: "otpauth://totp/x?secret=GEZDGNBV",
    });
    expect(text()).toContain("287082");
    expect(text()).toContain("29s");
  });

  it("an invalid secret shows an error and blocks saving", async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "totp_preview") throw "Not a valid TOTP secret";
      return [];
    });
    await render(<IdentityModal onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {
      setValue(input("name"), "x");
      setValue(input("username"), "u");
      setValue(input("totpSecret"), "nope");
    });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(text()).toContain("Not a valid TOTP secret");
    await act(async () => button("Save")?.click());
    expect(createIdentity).not.toHaveBeenCalled();
  });
});

describe("IdentityList", () => {
  it("usage message pluralises and is empty when unused", () => {
    expect(usageMessage(3, 1)).toBe(
      "Used by 3 hosts and 1 group. They'll ask for a login when connecting.",
    );
    expect(usageMessage(1, 0)).toBe(
      "Used by 1 host. They'll ask for a login when connecting.",
    );
    expect(usageMessage(0, 0)).toBe("");
  });

  it("delete warns with the usage count", async () => {
    useIdentityStore.setState({ identities: [identity] });
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "identity_usage" ? { hosts: 3, groups: 1 } : [],
    );
    await render(<IdentityList />);
    expect(text()).toContain("deploy@prod");
    await act(async () => button("Delete identity")?.click());
    expect(h.invoke).toHaveBeenCalledWith("identity_usage", {
      identityId: "i1",
      vaultId: "v1",
    });
    expect(text()).toContain(
      "Used by 3 hosts and 1 group. They'll ask for a login when connecting.",
    );
    await act(async () => button("Delete")?.click());
    expect(deleteIdentity).toHaveBeenCalledWith("i1");
  });
});

describe("KeysPage", () => {
  it("has Keys and Identities tabs", async () => {
    await render(<KeysPage />);
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(
      (t) => t.textContent,
    );
    expect(tabs).toEqual(["Keys", "Identities"]);
    await act(async () =>
      (document.querySelectorAll('[role="tab"]')[1] as HTMLElement).click(),
    );
    expect(text()).toContain("No identities");
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const panel = document.getElementById(
        tab.getAttribute("aria-controls") ?? "",
      );
      if (tab.getAttribute("aria-selected") === "true") {
        expect(panel?.getAttribute("role")).toBe("tabpanel");
        expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
      }
    }
  });
});
