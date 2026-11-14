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

const { fetchInherited } = vi.hoisted(() => ({ fetchInherited: vi.fn() }));
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
  }) => (
    <div data-testid="host-list">
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

  it("Connect while dirty asks before leaving the page", async () => {
    await mount();
    await click(button("Edit web"));
    type("name", "web2");
    await click(button("Connect web"));
    expect(asking()).toBe(true);
    await click(button("Keep editing"));
    expect(addTab).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("terminal page");

    await click(button("Connect web"));
    await click(button("Discard"));
    expect(addTab).toHaveBeenCalledWith("h1", "web", expect.anything());
    expect(document.body.textContent).toContain("terminal page");
  });
});
