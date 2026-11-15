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
import { useIdentityStore } from "@/stores/identities/identityStore";
import { useSettingsStore } from "@/stores/settings/settingsStore";
import { useSnippetStore } from "@/stores/snippets/snippetStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import HostForm from "./HostForm";

const EMPTY: InheritedDefaults = {
  hasPassword: false,
  startupKind: null,
  env: [],
};
const PORTED: InheritedDefaults = {
  ...EMPTY,
  port: 2222,
  portFrom: "prod",
  keepaliveSecs: 30,
  keepaliveFrom: "prod",
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
const IDENTITY = {
  id: "i1",
  name: "deploy@prod",
  vaultId: "v1",
  sortOrder: 0,
  createdAt: "1",
};
beforeEach(() => {
  fetchInherited.mockResolvedValue(EMPTY);
  useIdentityStore.setState({
    identities: [IDENTITY],
    error: null,
    fetchIdentities: vi.fn(async () => {}),
  });
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
    const option = [...document.querySelectorAll("[role=option]")].find(
      (e) => e.textContent === label,
    );
    if (!option) throw new Error(`option "${label}" not found in ${id}`);
    option.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });
};
const optionLabels = (id: string) => {
  click(document.getElementById(id) ?? undefined);
  return [...document.querySelectorAll("[role=option]")].map(
    (e) => e.textContent,
  );
};
const card = (title: string) =>
  [...document.querySelectorAll("aside section")].find(
    (c) => c.querySelector("h3")?.textContent === title,
  );
const summary = (title: string) =>
  card(title)?.querySelector("[data-card-summary]")?.textContent ?? undefined;
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

async function mountAndFill(
  groups: { id: string; name: string }[] = [],
  onClose = () => {},
) {
  const createHost = vi.fn();
  useHostStore.setState({ createHost, hosts: [], groups } as never);
  useVaultStore.setState({ currentVaultId: "v1" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<HostForm onClose={onClose} />);
  });
  pick("authType", "Password");
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
  it("shows cards in order", async () => {
    await mountAndFill();
    expect(document.querySelector("aside h2")?.textContent).toBe("New host");
    expect(
      [...document.querySelectorAll("aside section h3")].map(
        (h) => h.textContent,
      ),
    ).toEqual([
      "Address",
      "General",
      "Credentials",
      "Connection",
      "On connect",
      "Environment",
    ]);
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
      'input[placeholder="NAME"]',
    ) as HTMLInputElement;
    changeInput(nameInput, "1X");
    await submit();
    expect(document.body.textContent).toContain("no leading digit");
  });
});

describe("HostForm create", () => {
  it("a failed create keeps the draft and the form open", async () => {
    const onClose = vi.fn();
    const createHost = await mountAndFill([], onClose);
    createHost.mockResolvedValue(null);
    await submit();
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(input("name")?.value).toBe("n");
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
    const updateHost = vi.fn(
      async (_id: string, _p: Record<string, unknown>) => true,
    );
    useHostStore.setState({
      updateHost,
      hosts: [],
      groups: [
        { id: "g1", name: "one" },
        { id: "g2", name: "two" },
      ],
    } as never);
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
    const createHost = await mountAndFill([{ id: "g1", name: "one" }]);
    createHost.mockResolvedValue({ id: "new1" });
    pick("groupId", "one");
    await act(async () => {});
    await submit();
    expect(createHost.mock.calls[0][0].forwardAgent).toBeNull();
    expect(decisions()).toEqual({});
  });

  it("moving between groups that both inherit On keeps Don't allow", async () => {
    setDecisions({ h1: false });
    fetchInherited.mockResolvedValue({ ...EMPTY, forwardAgent: true });
    const updateHost = await mountEdit(null, () => {}, "g1");
    pick("groupId", "two");
    await act(async () => {});
    await submit();
    expect(updateHost.mock.calls[0][1]).toMatchObject({ groupId: "g2" });
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

  it("Identity hides the username and offers a picker with New identity", async () => {
    await mount({ host: existing({}) });
    pick("authType", "Identity");
    expect(input("username")).toBeNull();
    expect(input("password")).toBeNull();
    expect(optionLabels("identityId")).toEqual([
      "Select an identity",
      "deploy@prod",
      "+ New identity",
    ]);
  });

  it("saves identity login and keeps the stored username", async () => {
    const { updateHost } = await mount({ host: existing({}) });
    pick("authType", "Identity");
    pick("identityId", "deploy@prod");
    await submit();
    const patch = updateHost.mock.calls[0][1];
    expect(patch).toMatchObject({
      authType: "identity",
      identityId: "i1",
      username: "u",
    });
    expect(patch.password).toBeUndefined();
    expect(patch.keyId).toBeUndefined();
  });

  it("Identity without a pick asks for one", async () => {
    const { updateHost } = await mount({ host: existing({}) });
    pick("authType", "Identity");
    await submit();
    expect(updateHost).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Pick an identity");
  });

  it("+ New identity opens the identity form and selects the saved one", async () => {
    const createIdentity = vi.fn(async () => {
      useIdentityStore.setState((s) => ({
        identities: [...s.identities, { ...IDENTITY, id: "i2", name: "ops" }],
      }));
      return "i2";
    });
    useIdentityStore.setState({ createIdentity });
    await mount({ host: existing({}) });
    pick("authType", "Identity");
    pick("identityId", "+ New identity");
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
    expect(dialog?.textContent).toContain("New identity");
    const field = (name: string) =>
      dialog?.querySelector(`input[name="${name}"]`) as HTMLInputElement;
    changeInput(field("name"), "ops");
    changeInput(field("username"), "ops");
    await act(async () => {
      [...(dialog?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent === "Save")
        ?.click();
    });
    expect(createIdentity).toHaveBeenCalled();
    expect(document.getElementById("identityId")?.textContent).toBe("ops");
  });

  it("shows the inherited identity and hides the username", async () => {
    await mount({
      host: existing({ authType: "inherit" }),
      inherited: {
        ...EMPTY,
        username: "deploy",
        usernameFrom: "prod",
        authType: "identity",
        authFrom: "prod",
        identityName: "deploy@prod",
        identityFrom: "prod",
        identityUsername: "deploy",
      },
    });
    expect(document.body.textContent).toContain(
      "Identity 'deploy@prod' · prod",
    );
    expect(input("username")).toBeNull();
  });

  it("host form with a deleted identity shows Ask when connecting", async () => {
    await mount({
      host: existing({ authType: "identity", identityId: "gone" }),
    });
    expect(document.getElementById("authType")?.textContent).toBe(
      "Ask when connecting",
    );
  });

  it("puts the jump host in the Connection card", async () => {
    await mount({});
    expect(card("Connection")?.querySelector("#jumpHostId")).toBeTruthy();
  });

  it("summaries appear only when inherited", async () => {
    await mount({
      host: existing({ authType: "inherit" }),
      inherited: PROD,
    });
    expect(summary("Credentials")).toBe("from prod");
    expect(summary("Connection")).toBeUndefined();
  });

  it("no Credentials summary with its own password, none without a group", async () => {
    await mount({ host: existing({}), inherited: PROD });
    expect(summary("Credentials")).toBeUndefined();
    document.body.innerHTML = "";
    await mount({
      host: existing({ authType: "inherit", groupId: undefined }),
    });
    for (const t of ["Credentials", "Connection", "On connect", "Environment"])
      expect(summary(t)).toBeUndefined();
  });

  it("counts env vars across host and inherited rows", async () => {
    await mount({ host: existing({}), inherited: PROD });
    expect(summary("Environment")).toBe("1 var");
    click(byText("button", "Add variable"));
    // A blank row is not counted yet.
    expect(summary("Environment")).toBe("1 var");
    changeInput(input("env.0.name") as HTMLInputElement, "X");
    expect(summary("Environment")).toBe("2 vars");
    changeInput(input("env.0.name") as HTMLInputElement, "LANG");
    expect(summary("Environment")).toBe("1 var");
    document.body.innerHTML = "";
    await mount({ host: existing({}), inherited: EMPTY });
    expect(summary("Environment")).toBeUndefined();
  });

  it("shows the group's username as placeholder and allows it empty", async () => {
    const { createHost } = await mount({
      defaultGroupId: "g1",
      inherited: PROD,
    });
    expect(fetchInherited).toHaveBeenCalledWith("g1", "v1");
    expect(input("username")?.placeholder).toBe("deploy");
    await submit();
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(createHost.mock.calls[0][0]).toMatchObject({ username: "" });
  });

  it("marks only Address as required", async () => {
    await mount({});
    const stars = [...document.querySelectorAll("aside label")]
      .filter((l) => l.textContent?.includes("*"))
      .map((l) => l.textContent);
    expect(stars).toEqual(["Address*"]);
  });

  it("port and keepalive start empty with the resolved placeholders", async () => {
    await mount({ defaultGroupId: "g1", inherited: PORTED });
    expect(input("port")?.value).toBe("");
    expect(input("port")?.placeholder).toBe("2222 · prod");
    expect(input("keepaliveSecs")?.value).toBe("");
    expect(input("keepaliveSecs")?.placeholder).toBe("30 · prod");
    expect(document.body.textContent).toContain(
      "Seconds. Empty uses the group or default; 0 turns it off.",
    );
  });

  it("port placeholder is 22 without a group", async () => {
    await mount({});
    expect(input("port")?.placeholder).toBe("22");
  });

  it("username placeholder says it will ask without a group default", async () => {
    await mount({});
    expect(input("username")?.placeholder).toBe("Ask when connecting");
  });

  it("a new host without a group defaults to Ask when connecting", async () => {
    const { createHost } = await mount({});
    expect(document.getElementById("authType")?.textContent).toBe(
      "Ask when connecting",
    );
    await submit();
    expect(createHost.mock.calls[0][0].authType).toBe("none");
  });

  it("Add variable sits in the Environment card header", async () => {
    await mount({});
    const add = byText("button", "Add variable") as HTMLElement;
    expect(card("Environment")?.querySelector("header")?.contains(add)).toBe(
      true,
    );
  });

  it("keepalive 0 saves 0 and empty saves null", async () => {
    const { updateHost } = await mount({
      host: existing({ keepaliveSecs: 0 }),
    });
    expect(input("keepaliveSecs")?.value).toBe("0");
    await submit();
    expect(updateHost.mock.calls[0][1].keepaliveSecs).toBe(0);
    changeInput(input("keepaliveSecs") as HTMLInputElement, "");
    await submit();
    expect(updateHost.mock.calls[1][1].keepaliveSecs).toBeNull();
  });

  it("saves with only an address: name falls back to it, port null, username empty", async () => {
    const { createHost } = await mount({});
    changeInput(input("name") as HTMLInputElement, "");
    changeInput(input("address") as HTMLInputElement, "h.example");
    await submit();
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(createHost.mock.calls[0][0]).toMatchObject({
      name: "h.example",
      address: "h.example",
      port: null,
      username: "",
      keepaliveSecs: null,
    });
  });

  it("choosing No Group saves groupId null so the row really leaves the group", async () => {
    const { updateHost } = await mount({ host: existing({}), inherited: PROD });
    pick("groupId", "No Group");
    await submit();
    expect(updateHost.mock.calls[0][1].groupId).toBeNull();
  });

  it("offers From group auth only when the host has a group", async () => {
    await mount({});
    // Connection options have their own From group choices; check the login choices only.
    expect(optionLabels("authType")).toEqual([
      "Password",
      "SSH key",
      "Password + key",
      "Identity",
      "Ask when connecting",
    ]);
  });

  it("choosing From group hides secrets and saves inherit", async () => {
    const { updateHost } = await mount({
      host: existing({}),
      inherited: PROD,
    });
    // An existing password host keeps Password.
    expect(input("password")).not.toBeNull();
    pick("authType", "From group");
    expect(input("password")).toBeNull();
    expect(document.body.textContent).toContain("SSH key 'deploy-key' · prod");
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

  it("a new host in a group whose chain sets no auth still defaults to From group", async () => {
    const { createHost } = await mount({ defaultGroupId: "g1" });
    expect(document.getElementById("authType")?.textContent).toBe("From group");
    await submit();
    expect(createHost.mock.calls[0][0].authType).toBe("inherit");
  });

  it("an inherit host without a group asks for credentials or a group", async () => {
    const { updateHost } = await mount({
      host: existing({ authType: "inherit", groupId: undefined }),
    });
    expect(document.getElementById("authType")?.textContent).toBe("From group");
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

  it("renders env as a table with one header row and hidden per-row labels", async () => {
    await mount({
      host: existing({ env: [{ name: "TZ", value: "UTC" }] }),
      inherited: PROD,
    });
    expect(input("env.0.name")?.value).toBe("TZ");
    expect(document.querySelector('label[for="env.0.name"]')?.textContent).toBe(
      "Name 1",
    );
    expect(
      document.querySelector('label[for="env.0.value"]')?.textContent,
    ).toBe("Value 1");
    expect(
      document.querySelector('label[for="env.0.name"] > .sr-only')?.className,
    ).toContain("sr-only");
    expect(
      document.querySelectorAll("[data-env-header]").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      [...document.querySelectorAll("[data-env-header]")].map(
        (e) => e.textContent,
      ),
    ).toEqual(expect.arrayContaining(["Name", "Value"]));
    expect(
      document.querySelector('button[aria-label="Remove variable 1"]'),
    ).not.toBeNull();
  });

  it("shows inherited env greyed with group badge and Override", async () => {
    await mount({ host: existing({ env: [] }), inherited: PROD });
    const row = document.querySelector('[data-inherited-env="LANG"]');
    expect(row?.textContent).toContain("LANG");
    expect(row?.textContent).toContain("C.UTF-8");
    expect(row?.textContent).toContain("prod");
    expect(byText("button", "Override")).toBeDefined();
  });

  it("Override adds a prefilled host row; removing it restores the inherited row", async () => {
    await mount({ host: existing({ env: [] }), inherited: PROD });
    click(byText("button", "Override"));
    expect(input("env.0.name")?.value).toBe("LANG");
    expect(input("env.0.value")?.value).toBe("C.UTF-8");
    expect(document.querySelector('[data-inherited-env="LANG"]')).toBeNull();
    expect(document.body.textContent).toContain("overrides prod");
    click(
      document.querySelector(
        'button[aria-label="Remove variable 1"]',
      ) as Element,
    );
    expect(
      document.querySelector('[data-inherited-env="LANG"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("overrides prod");
  });

  it("renders AcceptEnv in <code> without backticks", async () => {
    await mount({});
    expect(document.querySelector("code")?.textContent).toBe("AcceptEnv");
    expect(document.body.textContent).not.toContain("`");
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

  it("a group picked before its lookup resolves still saves the From group defaults", async () => {
    const { createHost } = await mount({});
    fetchInherited.mockReturnValue(new Promise(() => {}));
    pick("groupId", "prod");
    await submit();
    const saved = createHost.mock.calls[0][0];
    expect(saved.authType).toBe("inherit");
    expect(saved.startup).toBeNull();
    expect(saved.forwardAgent).toBeNull();
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
    expect(input("username")?.placeholder).toBe("dev-user");
  });
  const GROUP_ALL: InheritedDefaults = {
    ...PROD,
    hasPassword: true,
    keepaliveSecs: 30,
    keepaliveFrom: "prod",
    startupKind: "command",
    startupFrom: "prod",
    forwardAgent: true,
    forwardAgentFrom: "prod",
  };

  it("shows the resolved login line under From group and never a password", async () => {
    await mount({
      host: existing({ authType: "inherit" }),
      inherited: GROUP_ALL,
    });
    expect(document.body.textContent).toContain("SSH key 'deploy-key' · prod");
    expect(document.body.textContent).not.toContain("pw");
    expect(input("password")).toBeNull();
  });

  it("explains an unset group login", async () => {
    await mount({ host: existing({ authType: "inherit" }) });
    expect(document.body.textContent).toContain(
      "No group sets a login — uses agent/none",
    );
  });

  it("shows password and key fields only for their methods", async () => {
    await mount({ host: existing({}), inherited: GROUP_ALL });
    expect(input("password")).not.toBeNull();
    pick("authType", "SSH key");
    expect(input("password")).toBeNull();
    expect(document.getElementById("keyId")).not.toBeNull();
    pick("authType", "Password + key");
    expect(input("password")).not.toBeNull();
    expect(document.getElementById("keyId")).not.toBeNull();
    pick("authType", "Ask when connecting");
    expect(input("password")).toBeNull();
    expect(document.getElementById("keyId")).toBeNull();
  });

  it("shows resolved lines under the connection From group choices", async () => {
    await mount({
      host: existing({
        keepaliveSecs: undefined,
        startup: undefined,
        forwardAgent: undefined,
      }),
      inherited: GROUP_ALL,
    });
    expect(input("keepaliveSecs")?.placeholder).toBe("30 · prod");
    const text = document.body.textContent ?? "";
    expect(text).toContain("runs a command · prod");
    expect(text).toContain("On · prod");
    expect(summary("Connection")).toBe("from prod");
    expect(summary("On connect")).toBe("from prod");
  });

  it("shows the default lines when nothing is inherited", async () => {
    await mount({
      host: existing({
        keepaliveSecs: undefined,
        startup: undefined,
        forwardAgent: undefined,
      }),
    });
    expect(input("keepaliveSecs")?.placeholder).toBe("Default");
    expect(document.body.textContent).toContain("Nothing");
  });

  it("shows a group badge on the username and a reset only when both have one", async () => {
    await mount({ host: existing({}), inherited: PROD });
    const reset = () =>
      document.querySelector('button[aria-label="Use group value"]');
    expect(reset()).not.toBeNull();
    // Rendered beside the field, never inside the input's own wrapper.
    const field = input("username")?.closest("[data-slot=field]");
    expect(field?.contains(reset() ?? null)).toBe(false);
    expect(field?.parentElement?.textContent).toContain("prod");
    expect(field?.querySelector("[class*=absolute]")).toBeNull();
    click(reset() ?? undefined);
    expect(input("username")?.value).toBe("");
    expect(reset()).toBeNull();
  });

  it("hides the reset when the group has no username", async () => {
    await mount({ host: existing({}), inherited: EMPTY });
    expect(
      document.querySelector('button[aria-label="Use group value"]'),
    ).toBeNull();
  });

  it("Override moves focus to the new row's value and names its variable", async () => {
    await mount({ host: existing({ env: [] }), inherited: PROD });
    const override = document.querySelector(
      'button[aria-label="Override LANG"]',
    );
    expect(override).not.toBeNull();
    expect(
      document.querySelector('[data-inherited-env="LANG"] [title="C.UTF-8"]'),
    ).not.toBeNull();
    click(override ?? undefined);
    await act(async () => {});
    expect(document.activeElement).toBe(input("env.0.value"));
  });

  it("removing a variable focuses the next row's remove button, or Add variable", async () => {
    await mount({
      host: existing({
        env: [
          { name: "A", value: "1" },
          { name: "B", value: "2" },
        ],
      }),
    });
    const remove = (n: number) =>
      document.querySelector(
        `button[aria-label="Remove variable ${n}"]`,
      ) as HTMLElement;
    click(remove(1));
    await act(async () => {});
    expect(document.activeElement).toBe(remove(1));
    click(remove(1));
    await act(async () => {});
    expect(document.activeElement).toBe(byText("button", "Add variable"));
  });

  it("Use group value moves focus to the username", async () => {
    await mount({ host: existing({}), inherited: PROD });
    click(
      document.querySelector('button[aria-label="Use group value"]') ??
        undefined,
    );
    await act(async () => {});
    expect(document.activeElement).toBe(input("username"));
  });

  it("says Overrides while the host has its own username", async () => {
    await mount({ host: existing({}), inherited: PROD });
    const hint = () =>
      input("username")?.closest("[data-slot=field]")?.parentElement
        ?.textContent;
    expect(hint()).toContain("Overrides");
    expect(hint()).not.toContain("From group");
    changeInput(input("username") as HTMLInputElement, "");
    expect(hint()).toContain("From group");
  });

  it("hides the env header until there is a row", async () => {
    await mount({ host: existing({ env: [] }) });
    expect(document.querySelector("[data-env-header]")).toBeNull();
    click(byText("button", "Add variable"));
    expect(document.querySelector("[data-env-header]")).not.toBeNull();
  });
});
