// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  createHost: vi.fn(),
  importKey: vi.fn(),
  run: null as null | (() => Promise<never>),
  hosts: [] as { id: string; name: string; groupId?: string | null }[],
  groups: [] as { id: string; name: string; parentId?: string | null }[],
  createGroup: vi.fn(),
  open: vi.fn(),
  detected: [{ source: "ssh_config", origin: "~/.ssh/config" }] as {
    source: string;
    origin: string;
  }[],
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
vi.mock("@/lib/import/hostImport", async (orig) => {
  const actual = await orig<typeof import("@/lib/import/hostImport")>();
  return {
    ...actual,
    runImport: (...a: Parameters<typeof actual.runImport>) =>
      h.run ? h.run() : actual.runImport(...a),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: () => ({
    hosts: h.hosts,
    groups: h.groups,
    createHost: h.createHost,
    createGroup: h.createGroup,
  }),
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
import ImportModal from "./ImportModal";

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
const host = (
  name: string,
  k: ReturnType<typeof key> | null = null,
  over: Record<string, unknown> = {},
) => ({
  id: name,
  name,
  hostname: `${name}.example.com`,
  user: "root",
  port: 22,
  jump: null,
  key: k,
  folder: [] as string[],
  tags: [] as string[],
  ...over,
});

const pv = (
  hosts: ReturnType<typeof host>[],
  skipped: { name: string; reason: string }[] = [],
  source = "ssh_config",
) => ({ source, origin: "~/.ssh/config", hosts, skipped });

const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

/** Opens the dialog; with `pick`, goes straight to the SSH config preview. */
async function mount(
  preview: unknown,
  onClose: () => void = () => {},
  pick = true,
) {
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "import_detect") return h.detected;
    if (cmd === "import_preview") return preview;
    return "PRIVATE";
  });
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(<ImportModal groupId="g1" onClose={onClose} />),
  );
  await act(async () => {});
  if (pick) {
    await act(async () => byLabel("Import from SSH config").click());
    await act(async () => {});
  }
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  h.hosts = [];
  h.groups = [];
  h.detected = [{ source: "ssh_config", origin: "~/.ssh/config" }];
  h.createGroup.mockImplementation(async (g: { name: string }) => ({
    id: `new-${g.name}`,
  }));
  h.run = null;
  h.keys = [];
  h.vaults = [{ id: "v1", name: "Personal", kind: "personal" }];
  h.currentVaultId = "v1";
  h.fetchKeys.mockResolvedValue(true);
  h.createHost.mockImplementation(async (x) => ({ ...x }));
});

describe("ImportModal", () => {
  it("shows empty state when no hosts", async () => {
    await mount(pv([]));
    expect(text()).toContain("No hosts found in ~/.ssh/config");
  });

  it('existing host row is disabled with "already in Shetu"', async () => {
    h.hosts = [{ id: "h1", name: "web", groupId: "g1" }];
    await mount(pv([host("web")]));
    expect(text()).toContain("already in Shetu");
    const box = document.querySelector(
      '[role="checkbox"]',
    ) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("encrypted key shows one passphrase field per key file", async () => {
    await mount(pv([host("a", key("encrypted")), host("b", key("encrypted"))]));
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(text()).toContain("Passphrase for id_ed25519");
  });

  it("import button reports counts and calls createHost with probeOs false", async () => {
    await mount(pv([host("a", key("ready")), host("b", key("ready"))]));
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
    await mount(pv([host("a"), host("b")]));
    h.run = async () => {
      h.hosts = [{ id: "h1", name: "a", groupId: "g1" }];
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
    await mount(pv([host("a")]));
    expect(h.fetchKeys).toHaveBeenCalledWith("v1");
    expect(importBtn().disabled).toBe(true);
    await act(async () => resolve());
    expect(importBtn().disabled).toBe(false);
  });

  it("footer names the vault; team notice only for team vaults", async () => {
    await mount(pv([host("a")]));
    expect(importBtn().textContent).toBe(
      "Import 1 hosts and 0 keys into Personal",
    );
    expect(text()).not.toContain("This is a team vault");
    document.body.innerHTML = "";
    h.vaults = [{ id: "v1", name: "Ops", kind: "team" }];
    await mount(pv([host("a")]));
    expect(importBtn().textContent).toContain("into Ops");
    expect(text()).toContain(
      "This is a team vault. Imported keys will be shared with its members.",
    );
  });

  it("key matching a vault key is not counted and needs no passphrase", async () => {
    h.keys = [{ id: "k1", fingerprint: "SHA256:abc" }];
    await mount(pv([host("a", key("encrypted", "SHA256:abc"))]));
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(importBtn().textContent).toContain("and 0 keys");
    document.body.innerHTML = "";
    await mount(pv([host("a", key("ready", "SHA256:abc"))]));
    expect(importBtn().textContent).toContain("and 0 keys");
  });

  it("reports an error toast when nothing was imported", async () => {
    await mount(pv([host("a")]));
    h.createHost.mockResolvedValue(null);
    await act(async () => importBtn().click());
    expect(toast.error).toHaveBeenCalledWith("No hosts were imported");
    expect(toast.success).not.toHaveBeenCalled();
    expect(text()).toContain("Couldn't create host");
  });

  it("failed key fetch keeps Import disabled and shows the message", async () => {
    h.fetchKeys.mockResolvedValue(false);
    await mount(pv([host("a")]));
    expect(importBtn().disabled).toBe(true);
    expect(text()).toContain("Couldn't load your keys for this vault.");
  });

  it("lists what was skipped and why", async () => {
    await mount(
      pv(
        [host("a")],
        [
          {
            name: "/home/u/.ssh/scoped.conf",
            reason:
              "Host blocks inside an Include under a Host entry aren't supported and were ignored",
          },
        ],
      ),
    );
    expect(text()).toContain(
      "/home/u/.ssh/scoped.conf: Host blocks inside an Include under a Host entry aren't supported and were ignored",
    );
  });

  it("cannot be closed while an import is running", async () => {
    const onClose = vi.fn();
    await mount(pv([host("a")]), onClose);
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

  it("source step lists every source, with Found for detected ones", async () => {
    h.detected = [
      { source: "ssh_config", origin: "~/.ssh/config" },
      { source: "putty", origin: "HKEY_CURRENT_USER\\Software\\SimonTatham" },
    ];
    await mount(pv([]), () => {}, false);
    for (const name of ["SSH config", "PuTTY", "WinSCP", "Termius (CSV)"])
      expect(text()).toContain(name);
    expect(text()).toContain("Found: ~/.ssh/config");
    expect(text()).toContain("Found: HKEY_CURRENT_USER");
    expect(byLabel("Import from PuTTY")).not.toBeNull();
    expect(byLabel("Import from WinSCP")).toBeNull();
    expect(byLabel("Choose SSH config file")).toBeNull();
    expect(byLabel("Choose Termius (CSV) file")).not.toBeNull();
  });

  it("Choose file previews the picked file", async () => {
    h.open.mockResolvedValue("/tmp/sites.reg");
    await mount(pv([host("a")], [], "putty"), () => {}, false);
    await act(async () => byLabel("Choose PuTTY file").click());
    await act(async () => {});
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: "PuTTY registry export", extensions: ["reg"] }],
      }),
    );
    expect(h.invoke).toHaveBeenCalledWith("import_preview", {
      source: "putty",
      path: "/tmp/sites.reg",
    });
    expect(text()).toContain("a.example.com");
  });

  it("a cancelled file pick stays on the source step", async () => {
    h.open.mockResolvedValue(null);
    await mount(pv([]), () => {}, false);
    await act(async () => byLabel("Choose WinSCP file").click());
    expect(h.invoke).not.toHaveBeenCalledWith(
      "import_preview",
      expect.anything(),
    );
    expect(text()).toContain("Termius (CSV)");
  });

  it("shows the target folder and creates it before the host", async () => {
    await mount(
      pv([host("web", null, { folder: ["Prod", "Web"] })], [], "winscp"),
    );
    expect(text()).toContain("Prod / Web");
    await act(async () => importBtn().click());
    expect(h.createGroup).toHaveBeenNthCalledWith(1, {
      name: "Prod",
      parentId: "g1",
    });
    expect(h.createGroup).toHaveBeenNthCalledWith(2, {
      name: "Web",
      parentId: "new-Prod",
    });
    expect(h.createHost.mock.calls[0][0]).toMatchObject({ groupId: "new-Web" });
  });

  it("reads keys through import_read_key for the chosen source", async () => {
    await mount(pv([host("a", key("ready"))]));
    await act(async () => importBtn().click());
    expect(h.invoke).toHaveBeenCalledWith("import_read_key", {
      source: "ssh_config",
      path: null,
      keyPath: "/home/u/.ssh/id_ed25519",
    });
  });

  it("Back returns to the sources", async () => {
    await mount(pv([host("a")]));
    await act(async () => byLabel("Back").click());
    expect(text()).toContain("Termius (CSV)");
  });
});
