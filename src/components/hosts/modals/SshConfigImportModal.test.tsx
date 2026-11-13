// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  createHost: vi.fn(),
  importKey: vi.fn(),
  hosts: [] as { id: string; name: string }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: () => ({ hosts: h.hosts, createHost: h.createHost }),
}));
vi.mock("@/stores/keys/keyStore", () => ({
  useKeyStore: () => ({ keys: [], importKey: h.importKey }),
}));

import { toast } from "sonner";
import SshConfigImportModal from "./SshConfigImportModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const key = (status: "ready" | "encrypted") => ({
  path: "/home/u/.ssh/id_ed25519",
  fileName: "id_ed25519",
  status,
  fingerprint: null,
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

async function mount(preview: unknown) {
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ssh_config_preview") return preview;
    return "PRIVATE";
  });
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  await act(async () =>
    root.render(<SshConfigImportModal groupId="g1" onClose={() => {}} />),
  );
  await act(async () => {});
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  h.hosts = [];
  h.createHost.mockImplementation(async (x) => ({ ...x }));
});

describe("SshConfigImportModal", () => {
  it("shows empty state when no hosts", async () => {
    await mount({ hosts: [], ignoredMatchFiles: [] });
    expect(text()).toContain("No hosts found in ~/.ssh/config");
  });

  it('existing host row is disabled with "already in Shetu"', async () => {
    h.hosts = [{ id: "h1", name: "web" }];
    await mount({ hosts: [host("web")], ignoredMatchFiles: [] });
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
    });
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(text()).toContain("Passphrase for id_ed25519");
  });

  it("import button reports counts and calls createHost with probeOs false", async () => {
    await mount({
      hosts: [host("a", key("ready")), host("b", key("ready"))],
      ignoredMatchFiles: [],
    });
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Import 2 hosts"),
    ) as HTMLButtonElement;
    expect(btn.textContent).toBe("Import 2 hosts and 1 keys");
    await act(async () => btn.click());
    expect(h.createHost).toHaveBeenCalledTimes(2);
    expect(h.createHost.mock.calls[0][1]).toEqual({ probeOs: false });
    expect(toast.success).toHaveBeenCalledWith("Imported 2 hosts and 1 keys");
  });
});
