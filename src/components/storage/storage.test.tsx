// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { useStorageAccountStore } from "@/stores/storage/storageAccountStore";
import StorageAccountList from "./StorageAccountList";
import StorageAccountModal from "./StorageAccountModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const text = () => document.body.textContent ?? "";
const field = (name: string) =>
  document.querySelector(`[name="${name}"]`) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
let root: Root | undefined;

function setValue(name: string, value: string) {
  const el = field(name);
  if (!el) throw new Error(`missing ${name}`);
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

async function render(node: React.ReactNode) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(node));
}

const save = vi.fn(async () => true);
const test = vi.fn(async () => "Connected to backups");

beforeEach(() => {
  vi.clearAllMocks();
  useStorageAccountStore.setState({ save, test } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

describe("StorageAccountModal", () => {
  it("fills the endpoint from the preset and shows provider fields", async () => {
    await render(<StorageAccountModal account="new" onClose={() => {}} />);
    await act(async () => setValue("provider", "aws"));
    await act(async () => setValue("region", "eu-west-1"));
    expect((field("endpoint") as HTMLInputElement).value).toBe(
      "https://s3.eu-west-1.amazonaws.com",
    );
    expect((field("endpoint") as HTMLInputElement).readOnly).toBe(true);
    expect(field("r2AccountId")).toBeNull();
    await act(async () => setValue("provider", "r2"));
    expect(field("r2AccountId")).not.toBeNull();
    await act(async () => setValue("provider", "custom"));
    expect((field("endpoint") as HTMLInputElement).readOnly).toBe(false);
    expect(field("pathStyle")).not.toBeNull();
    expect(text()).toContain("lifecycle rule");
  });

  it("requires a bucket and saves the patch", async () => {
    const onClose = vi.fn();
    await render(<StorageAccountModal account="new" onClose={onClose} />);
    await act(async () => setValue("name", "Backups"));
    await act(async () => setValue("provider", "aws"));
    await act(async () => setValue("region", "us-east-1"));
    await act(async () => setValue("accessKeyId", "AKIA"));
    await act(async () => setValue("secretAccessKey", "sec"));
    await act(async () => button("Save")?.click());
    expect(save).not.toHaveBeenCalled();
    expect(text()).toContain("Bucket is required");
    await act(async () => setValue("bucket", "backups"));
    await act(async () => button("Save")?.click());
    expect(save).toHaveBeenCalledWith(
      null,
      "Backups",
      expect.objectContaining({
        provider: "aws",
        bucket: "backups",
        secretAccessKey: "sec",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a saved secret unless one is typed, and tests the connection", async () => {
    h.invoke.mockResolvedValue({
      provider: "b2",
      endpoint: null,
      region: "us-west-004",
      bucket: "photos",
      pathStyle: false,
      r2AccountId: null,
      accessKeyId: "K004",
      hasSecret: true,
    });
    await render(
      <StorageAccountModal
        account={{ id: "s1", name: "Photos", vaultId: "v1" }}
        onClose={() => {}}
      />,
    );
    expect((field("secretAccessKey") as HTMLInputElement).value).toBe("");
    expect(text()).toContain("Saved");
    await act(async () => button("Test connection")?.click());
    expect(test).toHaveBeenCalledWith(
      "s1",
      expect.not.objectContaining({ secretAccessKey: expect.anything() }),
    );
    expect(text()).toContain("Connected to backups");
    await act(async () => button("Save")?.click());
    const patch = (save.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect("secretAccessKey" in patch).toBe(false);
  });

  it("can't save an edit before the saved account has loaded", async () => {
    let finish: (v: unknown) => void = () => {};
    h.invoke.mockImplementation(
      () => new Promise((r) => (finish = r)) as never,
    );
    useStorageAccountStore.setState({
      save,
      test,
      view: (id: string) => h.invoke("storage_account_view", { id }),
    } as never);
    await render(
      <StorageAccountModal
        account={{ id: "s1", name: "Photos", vaultId: "v1" }}
        onClose={() => {}}
      />,
    );
    expect(button("Save")?.disabled).toBe(true);
    await act(async () =>
      finish({
        provider: "aws",
        endpoint: null,
        region: "us-east-1",
        bucket: "photos",
        pathStyle: false,
        r2AccountId: null,
        accessKeyId: "AKIA",
        hasSecret: true,
      }),
    );
    expect(button("Save")?.disabled).toBe(false);
  });

  it("shows list errors instead of an empty list", async () => {
    useStorageAccountStore.setState({
      accounts: [],
      error: "Couldn't delete: offline",
      fetchStorageAccounts: async () => {},
    } as never);
    await render(<StorageAccountList />);
    expect(text()).toContain("Couldn't delete: offline");
  });

  it("says so when the saved account can't be loaded, and stays locked", async () => {
    useStorageAccountStore.setState({
      save,
      test,
      view: async () => {
        throw new Error("vault locked");
      },
    } as never);
    await render(
      <StorageAccountModal
        account={{ id: "s1", name: "Photos", vaultId: "v1" }}
        onClose={() => {}}
      />,
    );
    expect(text()).toContain("Couldn't load this account");
    expect(button("Save")?.disabled).toBe(true);
  });
});
