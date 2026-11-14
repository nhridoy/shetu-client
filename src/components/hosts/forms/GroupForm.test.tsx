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
import { useUnsavedChanges } from "@/stores/ui/unsavedChangesStore";
import { useVaultStore } from "@/stores/vault/vaultStore";
import GroupForm from "./GroupForm";

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
const changeInput = (el: Element | null, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    set?.call(el, value);
    el?.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

async function mount(
  group?: { id: string; name: string },
  decrypted = {},
  load?: () => Promise<unknown>,
) {
  const createGroup = vi.fn();
  const updateGroup = vi.fn();
  const getDecryptedGroup = vi.fn(
    load ?? (async () => ({ ...group, ...decrypted })),
  );
  useHostStore.setState({
    createGroup,
    updateGroup,
    getDecryptedGroup,
    hosts: [],
    groups: [],
  } as never);
  useVaultStore.setState({ currentVaultId: "v1" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <GroupForm
        group={group && { ...group, sortOrder: 0, createdAt: "" }}
        onClose={() => {}}
      />,
    );
  });
  return { createGroup, updateGroup };
}

const fillName = (v: string) =>
  changeInput(document.querySelector('input[id$="name"]'), v);

describe("GroupForm", () => {
  it("shows GENERAL, CREDENTIALS and CONNECTION without toggles", async () => {
    await mount();
    expect(document.querySelector("aside h2")?.textContent).toBe("New group");
    expect(document.body.textContent).toContain(
      "Hosts in this group use these unless they set their own.",
    );
    expect(
      [...document.querySelectorAll("aside h3")].map((h) => h.textContent),
    ).toEqual(["GENERAL", "CREDENTIALS", "CONNECTION"]);
    expect(byText("button", "Credentials")).toBeUndefined();
    expect(byText("button", "Advanced")).toBeUndefined();
    expect(document.body.textContent).toContain("Authentication");
    expect(document.body.textContent).toContain("On connect");
  });

  it("loaded values are the baseline, so only typing makes it dirty", async () => {
    await mount({ id: "g1", name: "prod" }, { username: "deploy" });
    expect(useUnsavedChanges.getState().dirty).toBe(false);
    fillName("prod2");
    await act(async () => {});
    expect(useUnsavedChanges.getState().dirty).toBe(true);
  });

  it("titles the edit panel with the group name", async () => {
    await mount({ id: "g1", name: "prod" });
    expect(document.querySelector("aside h2")?.textContent).toBe(
      "Edit group · prod",
    );
  });

  it("creates a group with username and password credentials", async () => {
    const { createGroup } = await mount();
    fillName("Prod");
    changeInput(document.querySelector('input[id$="username"]'), "deploy");
    click(byText("button", "Password"));
    changeInput(document.querySelector('input[type="password"]'), "pw");
    await submit();
    expect(createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Prod",
        username: "deploy",
        authType: "password",
        password: "pw",
      }),
    );
    const arg = createGroup.mock.calls[0][0];
    expect(arg.keyId).toBeUndefined();
    expect(arg.startup).toBeUndefined();
  });

  it("offers Not set but never From group as an auth method", async () => {
    await mount();
    expect(byText("button", "Not set")).toBeTruthy();
    expect(document.body.textContent).not.toContain("From group");
  });

  it("labels the null startup choice Not set", async () => {
    await mount();
    click(document.getElementById("startupMode") ?? undefined);
    const labels = [...document.querySelectorAll("[role=option]")].map(
      (e) => e.textContent,
    );
    expect(labels).toContain("Not set");
    expect(labels).not.toContain("None");
  });

  it("requires a password for password auth", async () => {
    const { createGroup } = await mount();
    fillName("Prod");
    click(byText("button", "Password"));
    await submit();
    expect(document.body.textContent).toContain("Password is required");
    expect(createGroup).not.toHaveBeenCalled();
  });

  it("requires a key for key auth", async () => {
    const { createGroup } = await mount();
    fillName("Prod");
    click(byText("button", "SSH Key"));
    await submit();
    expect(document.body.textContent).toContain("Please select an SSH key");
    expect(createGroup).not.toHaveBeenCalled();
  });

  it("shows the same env name error as hosts", async () => {
    await mount();
    fillName("Prod");
    click(byText("button", "Add variable"));
    changeInput(document.querySelector('input[placeholder="LANG"]'), "1X");
    await submit();
    expect(document.body.textContent).toContain("no leading digit");
  });

  it("loads decrypted values when editing and keeps them on save", async () => {
    const { updateGroup } = await mount(
      { id: "g1", name: "Prod" },
      {
        username: "deploy",
        authType: "password",
        password: "pw",
        keepaliveSecs: 30,
        env: [{ name: "LANG", value: "C" }],
        startup: { command: "ls" },
        forwardAgent: true,
      },
    );
    await submit();
    expect(updateGroup).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({
        name: "Prod",
        username: "deploy",
        authType: "password",
        password: "pw",
        keyId: null,
        keepaliveSecs: 30,
        env: [{ name: "LANG", value: "C" }],
        startup: { command: "ls" },
        forwardAgent: true,
      }),
    );
  });

  it("clears credentials with null when set back to Not set", async () => {
    const { updateGroup } = await mount(
      { id: "g1", name: "Prod" },
      { username: "deploy", authType: "password", password: "pw" },
    );
    click(byText("button", "Not set"));
    await submit();
    expect(updateGroup).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({ authType: null, password: null, keyId: null }),
    );
  });

  describe("while the stored values are unavailable", () => {
    const group = { id: "g1", name: "Prod" };
    const nameOnly = (updateGroup: ReturnType<typeof vi.fn>) => {
      expect(updateGroup).toHaveBeenCalledTimes(1);
      const patch = updateGroup.mock.calls[0][1];
      expect(Object.keys(patch).sort()).toEqual(["name", "parentId"]);
      expect(patch.name).toBe("Prod");
    };

    it("does not save before the stored values load, then keeps typed name", async () => {
      let resolve: (v: unknown) => void = () => {};
      const { updateGroup } = await mount(
        group,
        {},
        () => new Promise((r) => (resolve = r)),
      );
      changeInput(document.querySelector('input[id$="name"]'), "Renamed");
      await submit();
      expect(updateGroup).not.toHaveBeenCalled();
      await act(async () => {
        resolve({ ...group, username: "deploy" });
      });
      expect(
        (document.querySelector('input[id$="name"]') as HTMLInputElement).value,
      ).toBe("Renamed");
      await submit();
      expect(updateGroup).toHaveBeenCalledWith(
        "g1",
        expect.objectContaining({ name: "Renamed", username: "deploy" }),
      );
    });

    it("saves only the name when the group can't be read", async () => {
      const { updateGroup } = await mount(group, {}, async () => null);
      expect(document.body.textContent).toContain("Couldn't load");
      await submit();
      nameOnly(updateGroup);
    });

    it("shows an error and saves only the name when loading fails", async () => {
      const { updateGroup } = await mount(group, {}, async () => {
        throw new Error("boom");
      });
      expect(document.body.textContent).toContain("Couldn't load");
      await submit();
      nameOnly(updateGroup);
    });
  });
});
