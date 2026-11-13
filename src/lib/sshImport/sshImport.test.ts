import { describe, expect, it, vi } from "vitest";
import {
  type ImportDeps,
  planSshImport,
  runSshImport,
  type SshConfigHost,
  type SshConfigKey,
} from "./sshImport";

const key = (over: Partial<SshConfigKey> = {}): SshConfigKey => ({
  path: "/k/id",
  fileName: "id",
  status: "ready",
  fingerprint: null,
  keyType: "ed25519",
  ...over,
});

const host = (
  alias: string,
  over: Partial<SshConfigHost> = {},
): SshConfigHost => ({
  alias,
  hostname: `${alias}.example.com`,
  user: "me",
  port: 22,
  proxyJump: null,
  key: null,
  ...over,
});

const preview = (hosts: SshConfigHost[]) => ({ hosts, ignoredMatchFiles: [] });

function makeDeps(over: Partial<ImportDeps> = {}) {
  let n = 0;
  const createHost = vi.fn(async (h: Record<string, unknown>) => h as never);
  const importKey = vi.fn(async () => {});
  const deps: ImportDeps = {
    groupId: "g1",
    existingKeys: [],
    existingHosts: [],
    readKey: vi.fn(async (p: string) => `pem:${p}`),
    importKey,
    createHost,
    newId: () => `id${++n}`,
    ...over,
  };
  return { deps, createHost, importKey };
}

describe("planSshImport", () => {
  it("marks_existing_hosts", () => {
    const rows = planSshImport(preview([host("Web"), host("db")]), ["web"]);
    expect(rows.map((r) => r.existing)).toEqual([true, false]);
  });

  it("single_hop_jump_linked", () => {
    const rows = planSshImport(
      preview([
        host("a", { proxyJump: "b" }),
        host("b"),
        host("c", { proxyJump: "fixed" }),
      ]),
      ["Fixed"],
    );
    expect(rows[0].jumpAlias).toBe("b");
    expect(rows[2].jumpAlias).toBe("fixed");
  });

  it("jump_chain_drops_outer_link", () => {
    const rows = planSshImport(
      preview([
        host("A", { proxyJump: "B" }),
        host("B", { proxyJump: "C" }),
        host("C"),
      ]),
      [],
    );
    expect(rows[0].jumpAlias).toBeNull();
    expect(rows[0].jumpNote).toBe(
      "Jump chains aren't supported; imported without a jump host",
    );
    expect(rows[1].jumpAlias).toBe("C");
    const multi = planSshImport(preview([host("A", { proxyJump: "B,C" })]), []);
    expect(multi[0].jumpNote).toBe(
      "Jump chains aren't supported; imported without a jump host",
    );
  });

  it("unknown_jump_target_noted", () => {
    const rows = planSshImport(preview([host("A", { proxyJump: "zzz" })]), []);
    expect(rows[0].jumpAlias).toBeNull();
    expect(rows[0].jumpNote).toBe(
      "Jump host zzz isn't in your config or Shetu",
    );
  });

  it("notes_missing_and_unreadable_keys", () => {
    const rows = planSshImport(
      preview([
        host("a", { key: key({ status: "missing" }) }),
        host("b", { key: key({ status: "unreadable" }) }),
      ]),
      [],
    );
    expect(rows[0].keyNote).toBe("Key file not found; imported without a key");
    expect(rows[1].keyNote).toBe(
      "Key file couldn't be read; imported without a key",
    );
  });
});

describe("runSshImport", () => {
  it("same_key_file_imported_once", async () => {
    const { deps, createHost, importKey } = makeDeps();
    const rows = planSshImport(
      preview([host("a", { key: key() }), host("b", { key: key() })]),
      [],
    );
    const s = await runSshImport(rows, {}, deps);
    expect(importKey).toHaveBeenCalledTimes(1);
    const [a, b] = createHost.mock.calls.map((c) => c[0]);
    expect(a.keyId).toBeDefined();
    expect(a.keyId).toBe(b.keyId);
    expect(a.authType).toBe("key");
    expect(s).toEqual({ hostsImported: 2, keysImported: 1, problems: [] });
  });

  it("reuses_existing_key_by_fingerprint", async () => {
    const { deps, createHost, importKey } = makeDeps({
      existingKeys: [{ id: "k9", fingerprint: "SHA256:x" }],
    });
    const rows = planSshImport(
      preview([host("a", { key: key({ fingerprint: "SHA256:x" }) })]),
      [],
    );
    const s = await runSshImport(rows, {}, deps);
    expect(importKey).not.toHaveBeenCalled();
    expect(createHost.mock.calls[0][0].keyId).toBe("k9");
    expect(s.keysImported).toBe(0);
  });

  it("wrong_passphrase_does_not_abort", async () => {
    const importKey = vi.fn(async () => {
      throw new Error("bad passphrase");
    });
    const { deps, createHost } = makeDeps({ importKey });
    const rows = planSshImport(
      preview([host("a", { key: key({ status: "encrypted" }) }), host("b")]),
      [],
    );
    const s = await runSshImport(rows, { "/k/id": "nope" }, deps);
    expect(s.problems).toEqual([{ alias: "a", message: "bad passphrase" }]);
    expect(createHost.mock.calls[0][0].authType).toBe("password");
    expect(createHost).toHaveBeenCalledTimes(2);
    expect(s.hostsImported).toBe(2);
  });

  it("skips_encrypted_key_without_passphrase", async () => {
    const { deps, createHost, importKey } = makeDeps();
    const rows = planSshImport(
      preview([host("a", { key: key({ status: "encrypted" }) })]),
      [],
    );
    const s = await runSshImport(rows, {}, deps);
    expect(importKey).not.toHaveBeenCalled();
    expect(s.problems).toEqual([
      { alias: "a", message: "No passphrase given; imported without a key" },
    ]);
    expect(createHost.mock.calls[0][0].authType).toBe("password");
  });

  it("jump_host_id_points_to_row_or_existing", async () => {
    const { deps, createHost } = makeDeps({
      existingHosts: [{ id: "h7", name: "Fixed" }],
    });
    const rows = planSshImport(
      preview([
        host("a", { proxyJump: "b" }),
        host("b"),
        host("c", { proxyJump: "fixed" }),
        host("fixed"),
      ]),
      ["Fixed"],
    );
    await runSshImport(rows, {}, deps);
    const calls = createHost.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0].jumpHostId).toBe(calls[1].id);
    expect(calls[2].jumpHostId).toBe("h7");
  });

  it("defaults_user_to_root", async () => {
    const { deps, createHost } = makeDeps();
    const rows = planSshImport(preview([host("a", { user: null })]), []);
    await runSshImport(rows, {}, deps);
    expect(createHost.mock.calls[0][0]).toMatchObject({
      name: "a",
      address: "a.example.com",
      port: 22,
      username: "root",
      groupId: "g1",
    });
  });

  it("reports_failed_host_creation", async () => {
    const { deps } = makeDeps({ createHost: vi.fn(async () => null) });
    const rows = planSshImport(preview([host("a")]), []);
    const s = await runSshImport(rows, {}, deps);
    expect(s.hostsImported).toBe(0);
    expect(s.problems).toEqual([
      { alias: "a", message: "Couldn't create host" },
    ]);
  });
});
