// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

import type { InheritedDefaults } from "@/lib/hosts/inherited";
import { useHostStore } from "@/stores/hosts/hostStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import HostForm from "./HostForm";

const EMPTY: InheritedDefaults = {
  hasPassword: false,
  startupKind: null,
  env: [],
};
const PROD: InheritedDefaults = {
  ...EMPTY,
  username: "deploy",
  usernameFrom: "prod",
  authType: "key",
  authFrom: "prod",
  keyName: "deploy-key",
  env: [{ name: "LANG", value: "C.UTF-8", from: "prod" }],
};
beforeEach(() => {
  fetchInherited.mockResolvedValue(EMPTY);
});

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
const pick = (id: string, label: string) => {
  click(document.getElementById(id) ?? undefined);
  act(() => {
    [...document.querySelectorAll("[role=option]")]
      .find((e) => e.textContent === label)
      ?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
  });
};
const input = (name: string) =>
  document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
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

describe("HostForm panel", () => {
  it("shows GENERAL, CREDENTIALS and CONNECTION without toggles", async () => {
    await mountAndFill();
    expect(document.querySelector("aside h2")?.textContent).toBe("New host");
    expect(
      [...document.querySelectorAll("aside h3")].map((h) => h.textContent),
    ).toEqual(["GENERAL", "CREDENTIALS", "CONNECTION"]);
    expect(byText("button", "Advanced")).toBeUndefined();
    expect(document.body.textContent).toContain("On connect");
    expect(byText("button", "Save")).toBeTruthy();
    expect(byText("button", "Cancel")).toBeTruthy();
  });
});

describe("HostForm advanced validation", () => {
  it("shows the error for an invalid connection field", async () => {
    const createHost = await mountAndFill();
    // pick Startup = Snippet
    const startup = byText("button[role=combobox]", "None");
    click(startup);
    act(() => {
      byText("[role=option]", "Snippet")?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });

    await submit();

    expect(document.body.textContent).toContain("Select a snippet");
    expect(createHost).not.toHaveBeenCalled();
  });

  it("has an agent forwarding choice, off by default", async () => {
    await mountAndFill();
    expect(document.body.textContent).toContain(
      "Lets this server use your local SSH keys while you're connected. Anyone with root on the server can use them too. Only enable for servers you trust.",
    );
    expect(document.getElementById("forwardAgentMode")?.textContent).toBe(
      "Off",
    );
  });

  it("renders nested env name errors", async () => {
    await mountAndFill();
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
    useHostStore.setState({
      updateHost,
      hosts: [],
      groups: [
        { id: "g1", name: "one" },
        { id: "g2", name: "two" },
      ],
    } as never);
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
  const setForwarding = (label: "From group" | "On" | "Off") => {
    pick("forwardAgentMode", label);
  };
  async function mountEdit(
    forwardAgent: boolean | null,
    onClose = () => {},
    groupId?: string,
  ) {
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
      groupId,
      vaultId: "v1",
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
    setForwarding("On");
    await submit();
    expect(createHost.mock.calls[0][0].forwardAgent).toBe(true);
    expect(decisions()).toEqual({ new1: true });
  });

  it("turning it on for an existing host allows it on this device", async () => {
    setDecisions({ h1: false });
    await mountEdit(false);
    setForwarding("On");
    await submit();
    expect(decisions()).toEqual({ h1: true });
  });

  it("turning it off forgets this device's answer", async () => {
    setDecisions({ h1: false, other: true });
    await mountEdit(true);
    setForwarding("Off");
    await submit();
    expect(decisions()).toEqual({ other: true });
  });

  it("From group with an inherited On never records Allow from the form", async () => {
    setDecisions({ h1: false });
    fetchInherited.mockResolvedValue({ ...EMPTY, forwardAgent: true });
    await mountEdit(false, () => {}, "g1");
    setForwarding("From group");
    await submit();
    expect(decisions()).toEqual({ h1: false });
  });

  it("a new host inheriting On records no decision", async () => {
    setDecisions({});
    fetchInherited.mockResolvedValue({ ...EMPTY, forwardAgent: true });
    const createHost = await mountAndFill();
    createHost.mockResolvedValue({ id: "new1" });
    await submit();
    expect(decisions()).toEqual({});
  });

  it("moving between groups that both inherit On keeps Don't allow", async () => {
    setDecisions({ h1: false });
    fetchInherited.mockResolvedValue({ ...EMPTY, forwardAgent: true });
    await mountEdit(null, () => {}, "g1");
    pick("groupId", "two");
    await act(async () => {});
    await submit();
    expect(decisions()).toEqual({ h1: false });
  });

  it("an own On from an inheriting host records Allow", async () => {
    setDecisions({ h1: false });
    await mountEdit(null, () => {}, "g1");
    setForwarding("On");
    await submit();
    expect(decisions()).toEqual({ h1: true });
  });

  it("From group with nothing inherited forgets an own On's answer", async () => {
    setDecisions({ h1: true });
    await mountEdit(true, () => {}, "g1");
    setForwarding("From group");
    await submit();
    expect(decisions()).toEqual({});
  });

  it("leaves the decision alone when the inherited lookup failed", async () => {
    setDecisions({ h1: true });
    fetchInherited.mockRejectedValue(new Error("boom"));
    await mountEdit(true, () => {}, "g1");
    setForwarding("From group");
    await submit();
    expect(decisions()).toEqual({ h1: true });
  });

  it("saving an inheriting host untouched keeps the answer", async () => {
    setDecisions({ h1: false });
    fetchInherited.mockResolvedValue({ ...EMPTY, forwardAgent: true });
    await mountEdit(null, () => {}, "g1");
    await submit();
    expect(decisions()).toEqual({ h1: false });
  });

  it("a failed save keeps the answer and the form open", async () => {
    setDecisions({ h1: false });
    const onClose = vi.fn();
    const updateHost = await mountEdit(false, onClose);
    updateHost.mockResolvedValue(false);
    setForwarding("On");
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

describe("HostForm inherits from its group", () => {
  const GROUPS = [
    { id: "g1", name: "prod" },
    { id: "g2", name: "dev" },
  ];
  async function mount(opts: {
    host?: Record<string, unknown>;
    defaultGroupId?: string;
    inherited?: InheritedDefaults;
  }) {
    const createHost = vi.fn(async (_h: Record<string, unknown>) => ({
      id: "new1",
    }));
    const updateHost = vi.fn(
      async (_id: string, _p: Record<string, unknown>) => true,
    );
    if (opts.inherited) fetchInherited.mockResolvedValue(opts.inherited);
    useHostStore.setState({
      createHost,
      updateHost,
      hosts: [],
      groups: GROUPS,
    } as never);
    useVaultStore.setState({ currentVaultId: "v1" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <HostForm
          host={opts.host as never}
          defaultGroupId={opts.defaultGroupId}
          onClose={() => {}}
        />,
      );
    });
    if (!opts.host) {
      changeInput(input("name") as HTMLInputElement, "n");
      changeInput(input("address") as HTMLInputElement, "a");
    }
    return { createHost, updateHost };
  }
  const existing = (extra: Record<string, unknown>) => ({
    id: "h1",
    name: "n",
    address: "a",
    port: 22,
    username: "u",
    password: "pw",
    authType: "password",
    groupId: "g1",
    ...extra,
  });

  it("shows the group's username as placeholder and allows it empty", async () => {
    const { createHost } = await mount({
      defaultGroupId: "g1",
      inherited: PROD,
    });
    expect(fetchInherited).toHaveBeenCalledWith("g1", "v1");
    expect(input("username")?.placeholder).toBe("From group 'prod': deploy");
    await submit();
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(createHost.mock.calls[0][0]).toMatchObject({ username: "" });
  });

  it("requires a username without a group", async () => {
    const { createHost } = await mount({});
    changeInput(input("password") as HTMLInputElement, "pw");
    await submit();
    expect(document.body.textContent).toContain("Username is required");
    expect(createHost).not.toHaveBeenCalled();
  });

  it("requires a username when the chain has none", async () => {
    const { createHost } = await mount({ defaultGroupId: "g1" });
    changeInput(input("password") as HTMLInputElement, "pw");
    await submit();
    expect(document.body.textContent).toContain("Username is required");
    expect(createHost).not.toHaveBeenCalled();
  });

  it("choosing No Group saves groupId null so the row really leaves the group", async () => {
    const { updateHost } = await mount({ host: existing({}), inherited: PROD });
    pick("groupId", "No Group");
    await submit();
    expect(updateHost.mock.calls[0][1].groupId).toBeNull();
  });

  it("requires a username while the newly picked group's values are loading", async () => {
    const { updateHost } = await mount({ host: existing({}), inherited: PROD });
    changeInput(input("username") as HTMLInputElement, "");
    fetchInherited.mockReturnValueOnce(new Promise(() => {}));
    pick("groupId", "dev");
    await submit();
    expect(document.body.textContent).toContain("Username is required");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("offers From group auth only when the host has a group", async () => {
    await mount({});
    // Connection options have their own From group choices; check the login choices only.
    expect(byText("fieldset", "Authentication")?.textContent).not.toContain(
      "From group",
    );
  });

  it("choosing From group hides secrets and saves inherit", async () => {
    const { updateHost } = await mount({
      host: existing({}),
      inherited: PROD,
    });
    // An existing password host keeps Password.
    expect(input("password")).not.toBeNull();
    click(byText("button", "From group"));
    expect(input("password")).toBeNull();
    expect(document.body.textContent).toContain(
      "Using credentials from 'prod'",
    );
    expect(document.body.textContent).toContain("deploy-key");
    expect(document.body.textContent).not.toContain("pw");
    await submit();
    expect(updateHost.mock.calls[0][1].authType).toBe("inherit");
  });

  it("a new host in a group whose chain sets auth defaults to From group", async () => {
    const { createHost } = await mount({
      defaultGroupId: "g1",
      inherited: PROD,
    });
    expect(input("password")).toBeNull();
    await submit();
    expect(createHost.mock.calls[0][0].authType).toBe("inherit");
  });

  it("an inherit host without a group asks for credentials or a group", async () => {
    const { updateHost } = await mount({
      host: existing({ authType: "inherit", groupId: undefined }),
    });
    expect(byText("button", "From group")).toBeDefined();
    await submit();
    expect(updateHost).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Pick credentials or a group");
  });

  it("startup: new host in a group defaults to From group, None saves the marker", async () => {
    const first = await mount({ defaultGroupId: "g1", inherited: PROD });
    await submit();
    expect(first.createHost.mock.calls[0][0].startup).toBeNull();

    for (const r of roots.splice(0)) act(() => r.unmount());
    const second = await mount({ defaultGroupId: "g1", inherited: PROD });
    pick("startupMode", "None");
    await submit();
    expect(second.createHost.mock.calls[0][0].startup).toEqual({ none: true });
  });

  it("startup: an existing host with null startup in a group shows From group", async () => {
    await mount({ host: existing({ startup: null }) });
    expect(document.getElementById("startupMode")?.textContent).toBe(
      "From group",
    );
  });

  it("forwarding: From group saves null, Off false, On true", async () => {
    for (const [label, saved] of [
      [null, null],
      ["Off", false],
      ["On", true],
    ] as const) {
      for (const r of roots.splice(0)) act(() => r.unmount());
      const { createHost } = await mount({
        defaultGroupId: "g1",
        inherited: PROD,
      });
      expect(document.getElementById("forwardAgentMode")?.textContent).toBe(
        "From group",
      );
      if (label) pick("forwardAgentMode", label);
      await submit();
      expect(createHost.mock.calls[0][0].forwardAgent).toBe(saved);
    }
  });

  it("shows inherited env vars read-only above the host's own rows", async () => {
    await mount({
      host: existing({ env: [{ name: "TZ", value: "UTC" }] }),
      inherited: PROD,
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("LANG=C.UTF-8");
    expect(text).toContain("from prod");
    expect(text.indexOf("LANG=C.UTF-8")).toBeLessThan(
      text.indexOf("Add variable"),
    );
    expect(input("env.0.name")?.value).toBe("TZ");
    expect(document.querySelector('input[value="LANG"]')).toBeNull();
  });

  it("marks an inherited env var overridden by the host", async () => {
    await mount({
      host: existing({ env: [{ name: "LANG", value: "en_US" }] }),
      inherited: PROD,
    });
    expect(document.body.textContent).toContain("overridden");
  });

  it("a group change keeps choices the user made on a new host", async () => {
    await mount({});
    pick("forwardAgentMode", "On");
    pick("groupId", "prod");
    await act(async () => {});
    expect(document.getElementById("forwardAgentMode")?.textContent).toBe("On");
    expect(document.getElementById("startupMode")?.textContent).toBe(
      "From group",
    );
  });

  it("refetches when the group changes and ignores stale answers", async () => {
    let resolveFirst: (v: InheritedDefaults) => void = () => {};
    fetchInherited.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    await mount({ host: existing({ username: "" }) });
    fetchInherited.mockResolvedValue({
      ...EMPTY,
      username: "dev-user",
      usernameFrom: "dev",
    });
    pick("groupId", "dev");
    await act(async () => {});
    expect(fetchInherited).toHaveBeenLastCalledWith("g2", "v1");
    await act(async () => resolveFirst(PROD));
    expect(input("username")?.placeholder).toBe("From group 'dev': dev-user");
  });
});
