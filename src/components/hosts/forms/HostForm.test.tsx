// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import HostForm from "./HostForm";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => useSettingsStore.getState().initSettings());

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

const click = (el: Element | undefined) => {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const byText = (sel: string, text: string) =>
  [...document.querySelectorAll(sel)].find((e) =>
    e.textContent?.includes(text),
  );
const changeInput = (el: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

async function mountAndFill() {
  const createHost = vi.fn();
  useHostStore.setState({ createHost, hosts: [], groups: [] } as never);
  useVaultStore.setState({ currentVaultId: "v1" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<HostForm onClose={() => {}} />);
  });
  for (const [id, v] of [
    ["name", "n"],
    ["address", "a"],
    ["username", "u"],
    ["password", "pw"],
  ])
    changeInput(
      document.querySelector(
        `input[id$="${id}"], input[name="${id}"]`,
      ) as HTMLInputElement,
      v,
    );
  return createHost;
}

const submit = async () => {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

describe("HostForm advanced validation", () => {
  it("re-expands Advanced and shows the error when a hidden field is invalid", async () => {
    const createHost = await mountAndFill();
    click(byText("button", "Advanced"));
    // pick Startup = Snippet
    const startup = byText("button[role=combobox]", "None");
    click(startup);
    act(() => {
      byText("[role=option]", "Snippet")?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    click(byText("button", "Hide advanced"));
    expect(document.body.textContent).not.toContain("On connect");

    await submit();

    expect(document.body.textContent).toContain("On connect");
    expect(document.body.textContent).toContain("Select a snippet");
    expect(createHost).not.toHaveBeenCalled();
  });

  it("has an agent forwarding toggle in Advanced, off by default", async () => {
    await mountAndFill();
    expect(document.body.textContent).not.toContain("Forward SSH agent");
    click(byText("button", "Advanced"));
    expect(document.body.textContent).toContain(
      "Lets this server use your local SSH keys while you're connected. Anyone with root on the server can use them too. Only enable for servers you trust.",
    );
    const toggle = document.querySelector(
      'input[aria-label="Forward SSH agent"]',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("renders nested env name errors", async () => {
    await mountAndFill();
    click(byText("button", "Advanced"));
    click(byText("button", "Add variable"));
    const nameInput = document.querySelector(
      'input[placeholder="LANG"]',
    ) as HTMLInputElement;
    changeInput(nameInput, "1X");
    await submit();
    expect(document.body.textContent).toContain("no leading digit");
  });
});

describe("HostForm edit", () => {
  it("submits existing connection options unchanged", async () => {
    const updateHost = vi.fn();
    useHostStore.setState({ updateHost, hosts: [], groups: [] } as never);
    useVaultStore.setState({ currentVaultId: "v1" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const host = {
      id: "h1",
      name: "n",
      address: "a",
      port: 22,
      username: "u",
      password: "pw",
      authType: "password",
      color: "#64748b",
      tags: "[]",
      keepaliveSecs: 120,
      forwardAgent: true,
      env: [{ name: "LANG", value: "C.UTF-8" }],
      startup: { command: "tmux a" },
    };
    await act(async () => {
      root.render(<HostForm host={host as never} onClose={() => {}} />);
    });
    await submit();
    expect(updateHost).toHaveBeenCalledTimes(1);
    const patch = updateHost.mock.calls[0][1];
    expect(patch.keepaliveSecs).toBe(120);
    expect(patch.forwardAgent).toBe(true);
    expect(patch.env).toEqual([{ name: "LANG", value: "C.UTF-8" }]);
    expect(patch.startup).toEqual({ command: "tmux a" });
  });
});

describe("HostForm agent forwarding consent", () => {
  const decisions = () =>
    useSettingsStore.getState().settings.agentForwardingDecisions;
  const setDecisions = (d: Record<string, boolean>) =>
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, agentForwardingDecisions: d },
    }));
  const toggle = () => {
    click(byText("button", "Advanced"));
    click(
      document.querySelector('input[aria-label="Forward SSH agent"]') ??
        undefined,
    );
  };
  async function mountEdit(forwardAgent: boolean, onClose = () => {}) {
    const updateHost = vi.fn(async () => true);
    useHostStore.setState({ updateHost, hosts: [], groups: [] } as never);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const host = {
      id: "h1",
      name: "n",
      address: "a",
      port: 22,
      username: "u",
      password: "pw",
      authType: "password",
      forwardAgent,
    };
    await act(async () => {
      root.render(<HostForm host={host as never} onClose={onClose} />);
    });
    return updateHost;
  }

  it("turning it on for a new host allows it on this device", async () => {
    setDecisions({});
    const createHost = await mountAndFill();
    createHost.mockResolvedValue({ id: "new1" });
    toggle();
    await submit();
    expect(createHost.mock.calls[0][0].forwardAgent).toBe(true);
    expect(decisions()).toEqual({ new1: true });
  });

  it("turning it on for an existing host allows it on this device", async () => {
    setDecisions({ h1: false });
    await mountEdit(false);
    toggle();
    await submit();
    expect(decisions()).toEqual({ h1: true });
  });

  it("turning it off forgets this device's answer", async () => {
    setDecisions({ h1: false, other: true });
    await mountEdit(true);
    toggle();
    await submit();
    expect(decisions()).toEqual({ other: true });
  });

  it("a failed save keeps the answer and the form open", async () => {
    setDecisions({ h1: false });
    const onClose = vi.fn();
    const updateHost = await mountEdit(false, onClose);
    updateHost.mockResolvedValue(false);
    toggle();
    await submit();
    expect(updateHost).toHaveBeenCalledTimes(1);
    expect(decisions()).toEqual({ h1: false });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saving without touching it keeps the answer", async () => {
    setDecisions({ h1: false });
    await mountEdit(true);
    await submit();
    expect(decisions()).toEqual({ h1: false });
  });
});

describe("HostForm snippets", () => {
  it("loads snippets for the current vault on mount", async () => {
    const fetchSnippets = vi.fn().mockResolvedValue(undefined);
    useSnippetStore.setState({ fetchSnippets } as never);
    await mountAndFill();
    expect(fetchSnippets).toHaveBeenCalledWith("v1");
  });
});
