import { describe, expect, it, vi } from "vitest";
import {
  type ImportDeps,
  type ImportedHost,
  type ImportKey,
  type ImportPreview,
  planImport,
  runImport,
} from "./hostImport";

const key = (over: Partial<ImportKey> = {}): ImportKey => ({
  path: "/k/id",
  fileName: "id",
  status: "ready",
  fingerprint: null,
  keyType: "ed25519",
  ...over,
});

const host = (
  name: string,
  over: Partial<ImportedHost> = {},
): ImportedHost => ({
  id: name,
  name,
  hostname: `${name}.example.com`,
  user: "me",
  port: 22,
  jump: null,
  key: null,
  folder: [],
  tags: [],
  ...over,
});

const preview = (
  hosts: ImportedHost[],
  source = "ssh_config",
): ImportPreview => ({ source, origin: "test", hosts, skipped: [] });

/** Existing host names all sit in the dialog's group, "g1". */
const planSshImport = (p: ImportPreview, names: string[]) =>
  planImport(p, {
    rootGroupId: "g1",
    groups: [],
    hosts: names.map((name) => ({ name, groupId: "g1" })),
  });
const runSshImport = runImport;

function makeDeps(over: Partial<ImportDeps> = {}) {
  let n = 0;
  const createHost = vi.fn(async (h: Record<string, unknown>) => h as never);
  const importKey = vi.fn(async (_k: Record<string, unknown>) => {});
  const deps: ImportDeps = {
    groupId: "g1",
    source: "ssh_config",
    existingKeys: [],
    existingHosts: [],
    groups: [],
    createGroup: vi.fn(async (g: { name: string }) => ({
      id: `grp-${g.name}`,
    })),
    convertPpk: vi.fn(async (t: string) => `converted:${t}`),
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
        host("a", { jump: "b" }),
        host("b"),
        host("c", { jump: "fixed" }),
      ]),
      ["Fixed"],
    );
    expect(rows[0].jumpAlias).toBe("b");
    expect(rows[2].jumpAlias).toBe("fixed");
  });

  it("jump_chain_drops_outer_link", () => {
    const rows = planSshImport(
      preview([host("A", { jump: "B" }), host("B", { jump: "C" }), host("C")]),
      [],
    );
    expect(rows[0].jumpAlias).toBeNull();
    expect(rows[0].jumpNote).toBe(
      "Jump chains aren't supported; imported without a jump host",
    );
    expect(rows[1].jumpAlias).toBe("C");
    const multi = planSshImport(preview([host("A", { jump: "B,C" })]), []);
    expect(multi[0].jumpNote).toBe(
      "Jump chains aren't supported; imported without a jump host",
    );
  });

  it("unknown_jump_target_noted", () => {
    const rows = planSshImport(preview([host("A", { jump: "zzz" })]), []);
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
      existingHosts: [{ id: "h7", name: "Fixed", groupId: "g1" }],
    });
    const rows = planSshImport(
      preview([
        host("a", { jump: "b" }),
        host("b"),
        host("c", { jump: "fixed" }),
        host("fixed"),
      ]),
      ["Fixed"],
    );
    await runSshImport(rows, {}, deps);
    const calls = createHost.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    const by = (n: string) => calls.find((c) => c.name === n);
    expect(by("a")?.jumpHostId).toBe(by("b")?.id);
    expect(by("c")?.jumpHostId).toBe("h7");
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
  it("create_host_throw_is_reported_and_import_continues", async () => {
    const createHost = vi.fn(async (h: Record<string, unknown>) => {
      if (h.name === "a") throw new Error("db locked");
      return h as never;
    });
    const { deps } = makeDeps({ createHost });
    const rows = planSshImport(preview([host("a"), host("b")]), []);
    const s = await runSshImport(rows, {}, deps);
    expect(s.hostsImported).toBe(1);
    expect(s.problems).toEqual([{ alias: "a", message: "db locked" }]);
  });

  it("jump_target_creation_failed_drops_link", async () => {
    const createHost = vi.fn(async (h: Record<string, unknown>) =>
      h.name === "b" ? null : (h as never),
    );
    const { deps } = makeDeps({ createHost });
    const rows = planSshImport(
      preview([host("a", { jump: "b" }), host("b")]),
      [],
    );
    const s = await runSshImport(rows, {}, deps);
    const a = createHost.mock.calls
      .map((c) => c[0])
      .find((h) => h.name === "a");
    expect(a?.jumpHostId ?? null).toBeNull();
    expect(s.problems).toContainEqual({
      alias: "a",
      message: "Jump host b couldn't be imported; imported without a jump host",
    });
    expect(s.hostsImported).toBe(1);
  });

  it("notes_and_skipped_rows_reach_problems", async () => {
    const { deps } = makeDeps({
      existingHosts: [{ id: "e1", name: "old", groupId: "g1" }],
    });
    const rows = planSshImport(
      preview([
        host("nokey", { key: key({ status: "missing" }) }),
        host("chain", { jump: "x,y" }),
        host("old"),
      ]),
      ["old"],
    );
    const s = await runSshImport(rows, {}, deps);
    expect(s.problems).toEqual(
      expect.arrayContaining([
        {
          alias: "nokey",
          message: "Key file not found; imported without a key",
        },
        {
          alias: "chain",
          message: "Jump chains aren't supported; imported without a jump host",
        },
        { alias: "old", message: "Already in Shetu; skipped" },
      ]),
    );
    expect(s.problems).toHaveLength(3);
  });

  it("jump_target_defined_later_in_config_still_links", async () => {
    const { deps, createHost } = makeDeps();
    const rows = planSshImport(
      preview([host("a", { jump: "b" }), host("b")]),
      [],
    );
    await runSshImport(rows, {}, deps);
    const calls = createHost.mock.calls.map((c) => c[0]);
    expect(calls[0].name).toBe("b");
    expect(calls[1].jumpHostId).toBe(calls[0].id);
  });
});

describe("folders, groups and other sources", () => {
  const ctx = (
    groups: { id: string; name: string; parentId: string | null }[],
    hosts: { name: string; groupId: string | null }[] = [],
  ) => ({ rootGroupId: null, groups, hosts });

  it("folders_become_nested_groups_and_are_reused", async () => {
    const groups = [{ id: "p1", name: "prod", parentId: null }];
    const rows = planImport(
      preview(
        [
          host("web", { folder: ["Prod", "Web"] }),
          host("api", { folder: ["Prod", "Web"] }),
        ],
        "winscp",
      ),
      ctx(groups),
    );
    const createGroup = vi.fn(
      async (g: { name: string; parentId: string | null }) => ({
        id: `new-${g.name}`,
      }),
    );
    const { deps, createHost } = makeDeps({
      groupId: null,
      groups,
      createGroup,
    });
    await runImport(rows, {}, { ...deps, source: "winscp" });
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(createGroup).toHaveBeenCalledWith({ name: "Web", parentId: "p1" });
    expect(createHost.mock.calls.map((c) => c[0].groupId)).toEqual([
      "new-Web",
      "new-Web",
    ]);
  });

  it("same_name_folders_under_different_parents_stay_apart", async () => {
    const rows = planImport(
      preview(
        [
          host("a", { folder: ["A", "Web"] }),
          host("b", { folder: ["B", "Web"] }),
        ],
        "winscp",
      ),
      ctx([]),
    );
    let n = 0;
    const createGroup = vi.fn(async () => ({ id: `g${++n}` }));
    const { deps, createHost } = makeDeps({ groupId: null, createGroup });
    await runImport(rows, {}, { ...deps, source: "winscp" });
    expect(createGroup).toHaveBeenCalledTimes(4);
    const [a, b] = createHost.mock.calls.map((c) => c[0].groupId);
    expect(a).not.toBe(b);
  });

  it("duplicate_only_within_target_group", () => {
    const groups = [{ id: "p1", name: "Prod", parentId: null }];
    const rows = planImport(
      preview(
        [
          host("web", { folder: ["Prod"] }),
          host("web2", { folder: ["New"] }),
          host("db"),
        ],
        "winscp",
      ),
      ctx(groups, [
        { name: "web", groupId: null },
        { name: "web2", groupId: null },
        { name: "db", groupId: null },
      ]),
    );
    expect(rows.map((r) => [r.alias, r.existing])).toEqual([
      ["web", false],
      ["web2", false],
      ["db", true],
    ]);
    expect(rows[0].folder).toEqual(["Prod"]);
  });

  it("ppk_key_is_converted_before_import", async () => {
    const readKey = vi.fn(
      async () => "PuTTY-User-Key-File-3: ssh-ed25519\n...",
    );
    const { deps, importKey } = makeDeps({ readKey });
    const rows = planImport(
      preview(
        [host("a", { key: key({ status: "encrypted", path: "/k/a.ppk" }) })],
        "putty",
      ),
      ctx([]),
    );
    await runImport(rows, { "/k/a.ppk": "pw" }, { ...deps, source: "putty" });
    expect(deps.convertPpk).toHaveBeenCalledWith(
      "PuTTY-User-Key-File-3: ssh-ed25519\n...",
      "pw",
    );
    expect(importKey.mock.calls[0][0]).toMatchObject({
      encryptedPrivateKey: "converted:PuTTY-User-Key-File-3: ssh-ed25519\n...",
      passphrase: "pw",
    });
  });

  it("missing_user_left_empty_except_ssh_config", async () => {
    const rows = planImport(
      preview([host("a", { user: null })], "putty"),
      ctx([]),
    );
    const { deps, createHost } = makeDeps({ groupId: null });
    await runImport(rows, {}, { ...deps, source: "putty" });
    // Empty, not missing: the store would default a missing username to root.
    expect(createHost.mock.calls[0][0].username).toBe("");
  });

  it("tags_pass_through", async () => {
    const rows = planImport(
      preview([host("a", { tags: ["x", "y"] })], "termius_csv"),
      ctx([]),
    );
    const { deps, createHost } = makeDeps({ groupId: null });
    await runImport(rows, {}, { ...deps, source: "termius_csv" });
    expect(createHost.mock.calls[0][0].tags).toEqual(["x", "y"]);
  });

  it("jump_links_by_row_id", async () => {
    const rows = planImport(
      preview(
        [
          host("inner", { id: "p/inner", jump: "p/bastion" }),
          host("bastion", { id: "p/bastion" }),
        ],
        "tabby",
      ),
      ctx([]),
    );
    expect(rows[0].jumpAlias).toBe("p/bastion");
    const { deps, createHost } = makeDeps({ groupId: null });
    await runImport(rows, {}, { ...deps, source: "tabby" });
    const calls = createHost.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.name === "inner")?.jumpHostId).toBe(
      calls.find((c) => c.name === "bastion")?.id,
    );
  });

  it("failed_group_creation_lands_in_nearest_parent", async () => {
    const rows = planImport(
      preview([host("a", { folder: ["X"] })], "winscp"),
      ctx([]),
    );
    const { deps, createHost } = makeDeps({
      groupId: "root",
      createGroup: vi.fn(async () => null),
    });
    const s = await runImport(rows, {}, { ...deps, source: "winscp" });
    expect(createHost.mock.calls[0][0].groupId).toBe("root");
    expect(s.problems).toContainEqual({
      alias: "a",
      message: "Couldn't create group X; imported one level up",
    });
  });
});
