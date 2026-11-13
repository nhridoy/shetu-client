// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  createHost: vi.fn(),
  importKey: vi.fn(),
  run: null as null | (() => Promise<never>),
  hosts: [] as { id: string; name: string }[],
  keys: [] as { id: string; fingerprint?: string }[],
  fetchKeys: vi.fn(),
  vaults: [{ id: "v1", name: "Personal", kind: "personal" }] as {
    id: string;
    name: string;
    kind: string;
  }[],
  currentVaultId: "v1" as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/lib/sshImport/sshImport", async (orig) => {
  const actual = await orig<typeof import("@/lib/sshImport/sshImport")>();
  return {
    ...actual,
    runSshImport: (...a: Parameters<typeof actual.runSshImport>) =>
      h.run ? h.run() : actual.runSshImport(...a),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: () => ({ hosts: h.hosts, createHost: h.createHost }),
}));
vi.mock("@/stores/keys/keyStore", () => ({
  useKeyStore: () => ({
    keys: h.keys,
    importKey: h.importKey,
    fetchKeys: h.fetchKeys,
  }),
}));
vi.mock("@/stores/vault/vaultStore", () => ({
  VAULT_KIND_TEAM: "team",
  useVaultStore: () => ({ vaults: h.vaults, currentVaultId: h.currentVaultId }),
}));

import { toast } from "sonner";
import SshConfigImportModal from "./SshConfigImportModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const key = (
  status: "ready" | "encrypted",
  fingerprint: string | null = null,
) => ({
  path: "/home/u/.ssh/id_ed25519",
  fileName: "id_ed25519",
  status,
  fingerprint,
  keyType: "ed25519",
});
const host = (alias: string, k: ReturnType<typeof key> | null = null) => ({
  alias,
  hostname: `${alias}.example.com`,
  user: "root",
  port: 22,
  proxyJump: null,
  key: k,
});

async function mount(preview: unknown, onClose: () => void = () => {}) {
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ssh_config_preview") return preview;
    return "PRIVATE";
  });
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(<SshConfigImportModal groupId="g1" onClose={onClose} />),
  );
  await act(async () => {});
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  h.hosts = [];
  h.run = null;
  h.keys = [];
  h.vaults = [{ id: "v1", name: "Personal", kind: "personal" }];
  h.currentVaultId = "v1";
  h.fetchKeys.mockResolvedValue(true);
  h.createHost.mockImplementation(async (x) => ({ ...x }));
});

describe("SshConfigImportModal", () => {
  it("shows empty state when no hosts", async () => {
    await mount({
      hosts: [],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(text()).toContain("No hosts found in ~/.ssh/config");
  });

  it('existing host row is disabled with "already in Shetu"', async () => {
    h.hosts = [{ id: "h1", name: "web" }];
    await mount({
      hosts: [host("web")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(text()).toContain("already in Shetu");
    const box = document.querySelector(
      '[role="checkbox"]',
    ) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("encrypted key shows one passphrase field per key file", async () => {
    await mount({
      hosts: [host("a", key("encrypted")), host("b", key("encrypted"))],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(text()).toContain("Passphrase for id_ed25519");
  });

  it("import button reports counts and calls createHost with probeOs false", async () => {
    await mount({
      hosts: [host("a", key("ready")), host("b", key("ready"))],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Import 2 hosts"),
    ) as HTMLButtonElement;
    expect(btn.textContent).toBe("Import 2 hosts and 1 keys into Personal");
    await act(async () => btn.click());
    expect(h.createHost).toHaveBeenCalledTimes(2);
    expect(h.createHost.mock.calls[0][1]).toEqual({ probeOs: false });
    expect(toast.success).toHaveBeenCalledWith("Imported 2 hosts and 1 keys");
  });

  it("unexpected import error keeps the list and marks created hosts as existing", async () => {
    await mount({
      hosts: [host("a"), host("b")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    h.run = async () => {
      h.hosts = [{ id: "h1", name: "a" }];
      throw new Error("boom");
    };
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Import 2 hosts"),
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    expect(text()).toContain("Import stopped: boom");
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(text()).toContain("already in Shetu");
    expect(text()).toContain("Import 1 hosts and 0 keys");
  });

  const importBtn = () =>
    [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Import "),
    ) as HTMLButtonElement;

  it("fetches keys for the current vault and keeps Import disabled until done", async () => {
    let resolve!: () => void;
    h.fetchKeys.mockReturnValue(
      new Promise<boolean>((r) => (resolve = () => r(true))),
    );
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(h.fetchKeys).toHaveBeenCalledWith("v1");
    expect(importBtn().disabled).toBe(true);
    await act(async () => resolve());
    expect(importBtn().disabled).toBe(false);
  });

  it("footer names the vault; team notice only for team vaults", async () => {
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(importBtn().textContent).toBe(
      "Import 1 hosts and 0 keys into Personal",
    );
    expect(text()).not.toContain("This is a team vault");
    document.body.innerHTML = "";
    h.vaults = [{ id: "v1", name: "Ops", kind: "team" }];
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(importBtn().textContent).toContain("into Ops");
    expect(text()).toContain(
      "This is a team vault. Imported keys will be shared with its members.",
    );
  });

  it("key matching a vault key is not counted and needs no passphrase", async () => {
    h.keys = [{ id: "k1", fingerprint: "SHA256:abc" }];
    await mount({
      hosts: [host("a", key("encrypted", "SHA256:abc"))],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(importBtn().textContent).toContain("and 0 keys");
    document.body.innerHTML = "";
    await mount({
      hosts: [host("a", key("ready", "SHA256:abc"))],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(importBtn().textContent).toContain("and 0 keys");
  });

  it("reports an error toast when nothing was imported", async () => {
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    h.createHost.mockResolvedValue(null);
    await act(async () => importBtn().click());
    expect(toast.error).toHaveBeenCalledWith("No hosts were imported");
    expect(toast.success).not.toHaveBeenCalled();
    expect(text()).toContain("Couldn't create host");
  });

  it("failed key fetch keeps Import disabled and shows the message", async () => {
    h.fetchKeys.mockResolvedValue(false);
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: [],
    });
    expect(importBtn().disabled).toBe(true);
    expect(text()).toContain("Couldn't load your keys for this vault.");
  });

  it("notes Host blocks ignored inside scoped Includes", async () => {
    await mount({
      hosts: [host("a")],
      ignoredMatchFiles: [],
      ignoredScopedIncludeFiles: ["/home/u/.ssh/scoped.conf"],
    });
    expect(text()).toContain(
      "Host blocks inside an Include under a Host entry aren't supported and were ignored in: /home/u/.ssh/scoped.conf",
    );
  });

  it("cannot be closed while an import is running", async () => {
    const onClose = vi.fn();
    await mount(
      {
        hosts: [host("a")],
        ignoredMatchFiles: [],
        ignoredScopedIncludeFiles: [],
      },
      onClose,
    );
    let finish!: () => void;
    h.run = () =>
      new Promise<never>((_, rej) => (finish = () => rej(new Error("x"))));
    await act(async () => importBtn().click());
    expect(document.querySelector('[aria-label="Close"]')).toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
  });
});
