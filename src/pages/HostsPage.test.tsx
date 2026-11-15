// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { fetchInherited, toastError } = vi.hoisted(() => ({
  fetchInherited: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/lib/hosts/inherited", () => ({
  fetchInheritedDefaults: fetchInherited,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    entries: async () => [],
    set: async () => {},
    save: async () => {},
  }),
}));
vi.mock("@/lib/db/db");
vi.mock("@/lib/crypto/crypto");
vi.mock("@/stores/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));
// The real list needs drag-and-drop; a stub exposes the same callbacks.
vi.mock("@/components/hosts/panels/HostsPanel", () => ({
  default: (p: {
    onEditHost: (h: unknown) => void;
    onNewHost: (g?: string) => void;
    onNewGroup: (p?: string) => void;
    onConnect: (h: unknown) => void;
    onEditGroup: (g: unknown) => void;
  }) => (
    <div data-testid="host-list">
      <button type="button" onClick={() => p.onEditGroup({ id: "g1" })}>
        Edit prod
      </button>
      <button type="button" onClick={() => p.onEditHost(HOSTS[0])}>
        Edit web
      </button>
      <button type="button" onClick={() => p.onEditHost(HOSTS[1])}>
        Edit db
      </button>
      <button type="button" onClick={() => p.onNewHost()}>
        List new host
      </button>
      <button type="button" onClick={() => p.onNewHost("g1")}>
        List new host in prod
      </button>
      <button type="button" onClick={() => p.onNewGroup()}>
        List new group
      </button>
      <button type="button" onClick={() => p.onConnect(HOSTS[0])}>
        Connect web
      </button>
      <button type="button" onClick={() => p.onConnect(HOSTS[1])}>
        Connect db
      </button>
    </div>
  ),
}));

import UnsavedChangesDialog from "@/components/common/UnsavedChangesDialog";
import type { InheritedDefaults } from "@/lib/hosts/inherited";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import HostsPage from "./HostsPage";

const HOSTS = [
  {
    id: "h1",
    name: "web",
    address: "10.0.0.1",
    port: 22,
    username: "u",
    password: "pw",
    authType: "password",
    vaultId: "v1",
  },
  {
    id: "h2",
    name: "db",
    address: "10.0.0.2",
    port: 22,
    username: "u",
    password: "pw",
    authType: "password",
    vaultId: "v1",
  },
];
const EMPTY: InheritedDefaults = {
  hasPassword: false,
  startupKind: null,
  env: [],
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => useSettingsStore.getState().initSettings());

const roots: Root[] = [];
let addTab: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchInherited.mockResolvedValue(EMPTY);
  addTab = vi.fn();
  useTerminalStore.setState({ addTab } as never);
  useVaultStore.setState({ currentVaultId: "v1" });
  useHostStore.setState({
    hosts: HOSTS,
    groups: [{ id: "g1", name: "prod" }],
    getDecryptedHost: vi.fn(async (id: string) =>
      HOSTS.find((h) => h.id === id),
    ),
    getDecryptedGroup: vi.fn(async () => ({ id: "g1", name: "prod" })),
    createHost: vi.fn(),
    updateHost: vi.fn(async () => true),
    deleteHost: vi.fn(),
    deleteGroup: vi.fn(),
  } as never);
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  useUnsavedChanges.getState().answer(false);
  useUnsavedChanges.getState().setDirty(false);
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/hosts"]}>
        <Routes>
          <Route path="/hosts" element={<HostsPage />} />
          <Route path="/terminal" element={<p>terminal page</p>} />
        </Routes>
        <UnsavedChangesDialog />
      </MemoryRouter>,
    );
  });
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  ) as HTMLElement;
const click = async (el: Element | null) => {
  if (!el) throw new Error("element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const type = (name: string, value: string) =>
  act(() => {
    const el = document.querySelector(`input[name="${name}"]`);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(el, value);
    el?.dispatchEvent(new Event("input", { bubbles: true }));
  });
const title = () => document.querySelector("aside h2")?.textContent;
const asking = () => document.body.textContent?.includes("Discard changes?");

describe("HostsPage side panel", () => {
  it("opens host panel beside the list", async () => {
    await mount();
    await click(button("List new host"));
    expect(title()).toBe("New host");
    expect(document.querySelector('[data-testid="host-list"]')).toBeTruthy();
    await click(button("Edit web"));
    expect(title()).toBe("Edit host · web");
    expect(document.querySelector('[data-testid="host-list"]')).toBeTruthy();
  });

  it("opens the group panel with its title", async () => {
    await mount();
    await click(button("List new group"));
    expect(title()).toBe("New group");
  });

  it("edit host without typing closes without prompt", async () => {
    await mount();
    await click(button("Edit web"));
    await click(document.querySelector('[aria-label="Close panel"]'));
    expect(asking()).toBe(false);
    expect(document.querySelector("aside")).toBeNull();
  });

  it("new host in a group: inherited defaults are not edits", async () => {
    fetchInherited.mockResolvedValue({ ...EMPTY, authType: "key" });
    await mount();
    await click(button("List new host in prod"));
    type("name", "x");
    type("name", "");
    await click(button("Cancel"));
    expect(asking()).toBe(false);
    expect(document.querySelector("aside")).toBeNull();
  });

  it("switching to another host while dirty asks", async () => {
    await mount();
    await click(button("Edit web"));
    type("name", "web2");
    await click(button("Edit db"));
    expect(asking()).toBe(true);
    await click(button("Keep editing"));
    expect(title()).toBe("Edit host · web");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("web2");
    await click(button("Edit db"));
    await click(button("Discard"));
    expect(title()).toBe("Edit host · db");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("db");
  });

  it("New group while editing a host asks when dirty", async () => {
    await mount();
    await click(button("Edit web"));
    await click(button("List new group"));
    expect(asking()).toBe(false);
    expect(title()).toBe("New group");

    await click(button("Edit web"));
    type("name", "web2");
    await click(button("List new group"));
    expect(asking()).toBe(true);
    await click(button("Discard"));
    expect(title()).toBe("New group");
  });

  it("switching vault closes the open panel", async () => {
    await mount();
    await click(button("Edit web"));
    type("name", "web2");
    await act(async () => useVaultStore.setState({ currentVaultId: "v2" }));
    expect(document.querySelector("aside")).toBeNull();
  });

  it("a superseded group save never closes the panel that replaced it", async () => {
    let finishSave = () => {};
    useHostStore.setState({
      updateGroup: vi.fn(
        () => new Promise<void>((r) => (finishSave = () => r())),
      ),
    } as never);
    await mount();
    await click(button("Edit prod"));
    expect(title()).toBe("Edit group · prod");
    type("name", "prod2");
    await act(async () => {
      document
        .querySelector("aside form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await click(button("Edit web"));
    await click(button("Discard"));
    expect(title()).toBe("Edit host · web");
    type("name", "typed");
    await act(async () => finishSave());
    expect(title()).toBe("Edit host · web");
    expect(
      (document.querySelector('input[name="name"]') as HTMLInputElement).value,
    ).toBe("typed");
  });

  it("card click connects when no panel is open", async () => {
    await mount();
    await click(button("Connect web"));
    expect(addTab).toHaveBeenCalledWith("h1", "web", expect.anything());
    expect(document.body.textContent).toContain("terminal page");
  });

  it("card click while a panel is open switches the panel to that host", async () => {
    await mount();
    await click(button("List new host"));
    await click(button("Connect db"));
    expect(title()).toBe("Edit host · db");
    expect(addTab).not.toHaveBeenCalled();

    type("name", "db2");
    await click(button("Connect web"));
    expect(asking()).toBe(true);
    await click(button("Keep editing"));
    expect(title()).toBe("Edit host · db");
    await click(button("Connect web"));
    await click(button("Discard"));
    expect(title()).toBe("Edit host · web");
    expect(addTab).not.toHaveBeenCalled();
  });
});

describe("HostsPage late edit-host loads", () => {
  // Decrypts resolve only when the test says so (the form's bastion list decrypts too).
  function deferDecrypt() {
    const pending: [string, (v: unknown) => void][] = [];
    useHostStore.setState({
      getDecryptedHost: vi.fn(
        (id: string) => new Promise((r) => pending.push([id, r])),
      ),
    } as never);
    return async (id: string) => {
      await act(async () => {
        for (const [pid, r] of pending)
          if (pid === id) r(HOSTS.find((h) => h.id === id));
      });
    };
  }
  const nameValue = () =>
    (document.querySelector('input[name="name"]') as HTMLInputElement).value;

  it("ignores an earlier edit open that resolves last", async () => {
    const resolve = deferDecrypt();
    await mount();
    await click(button("Edit web"));
    await click(button("Edit db"));
    await resolve("h2");
    expect(title()).toBe("Edit host · db");
    type("name", "db2");
    await resolve("h1");
    expect(asking()).toBe(false);
    expect(title()).toBe("Edit host · db");
    expect(nameValue()).toBe("db2");
  });

  it("an older edit open never replaces a newer New group panel", async () => {
    const resolve = deferDecrypt();
    await mount();
    await click(button("Edit web"));
    await click(button("List new group"));
    expect(title()).toBe("New group");
    await resolve("h1");
    expect(asking()).toBe(false);
    expect(title()).toBe("New group");
  });

  it("asks when the open panel was edited while the next host loaded", async () => {
    const resolve = deferDecrypt();
    await mount();
    await click(button("List new host"));
    await click(button("Edit db"));
    type("name", "typed");
    await resolve("h2");
    expect(asking()).toBe(true);
    await click(button("Keep editing"));
    expect(title()).toBe("New host");
    expect(nameValue()).toBe("typed");
  });

  it("a pending edit open is dropped once the panel is closed", async () => {
    const resolve = deferDecrypt();
    await mount();
    await click(button("List new host"));
    await click(button("Edit db"));
    await click(document.querySelector('[aria-label="Close panel"]'));
    expect(document.querySelector("aside")).toBeNull();
    await resolve("h2");
    expect(document.querySelector("aside")).toBeNull();
  });

  it("shows an error and opens nothing when decrypting fails", async () => {
    useHostStore.setState({
      getDecryptedHost: vi.fn(async () => {
        throw new Error("locked");
      }),
    } as never);
    await mount();
    await click(button("Edit web"));
    expect(toastError).toHaveBeenCalledWith("Couldn't read this host");
    expect(document.querySelector("aside")).toBeNull();
  });
});
