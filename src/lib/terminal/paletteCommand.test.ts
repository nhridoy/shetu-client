import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: { getState: () => ({ hosts: [] }) },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import {
  pickPaletteItem,
  resolvePaletteCommand,
  runInAllTabs,
} from "./paletteCommand";

const deps = (over: Partial<Parameters<typeof pickPaletteItem>[2]> = {}) => ({
  activePaneId: "p1" as string | null,
  decryptSnippet: vi.fn(async () => ({ command: "docker ps" })),
  isConnected: vi.fn(() => true),
  insert: vi.fn(() => "ok" as const),
  askVariables: vi.fn(async () => ({}) as Record<string, string> | null),
  ...over,
});

describe("pickPaletteItem", () => {
  it("snippet_is_decrypted_before_insert", async () => {
    const d = deps();
    const result = await pickPaletteItem(
      { snippetId: "s1", command: "" },
      true,
      d,
    );
    expect(result).toBe("ok");
    expect(d.decryptSnippet).toHaveBeenCalledWith("s1");
    expect(d.insert).toHaveBeenCalledWith("p1", "docker ps", true);
  });

  it("fills variables before inserting", async () => {
    const d = deps({
      decryptSnippet: vi.fn(async () => ({ command: "tail -n {{n}} {{f}}" })),
      askVariables: vi.fn(async () => ({ n: "20", f: "app.log" })),
    });
    expect(
      await pickPaletteItem({ snippetId: "s1", command: "" }, true, d),
    ).toBe("ok");
    expect(d.askVariables).toHaveBeenCalledWith(["n", "f"]);
    expect(d.insert).toHaveBeenCalledWith("p1", "tail -n 20 app.log", true);
  });

  it("cancel sends nothing", async () => {
    const d = deps({
      decryptSnippet: vi.fn(async () => ({ command: "echo {{x}}" })),
      askVariables: vi.fn(async () => null),
    });
    expect(
      await pickPaletteItem({ snippetId: "s1", command: "" }, true, d),
    ).toBe("cancelled");
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("no variables means no form", async () => {
    const d = deps();
    await pickPaletteItem({ snippetId: "s1", command: "" }, true, d);
    expect(d.askVariables).not.toHaveBeenCalled();
  });

  it("builtin_inserts_its_command", async () => {
    const d = deps();
    await pickPaletteItem({ command: "journalctl -u " }, false, d);
    expect(d.decryptSnippet).not.toHaveBeenCalled();
    expect(d.insert).toHaveBeenCalledWith("p1", "journalctl -u ", false);
  });

  it("no_active_pane", async () => {
    const d = deps({ activePaneId: null });
    expect(await pickPaletteItem({ command: "ls" }, false, d)).toBe("no-pane");
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("decrypt_failure", async () => {
    const nullDecrypt = deps({ decryptSnippet: vi.fn(async () => null) });
    expect(
      await pickPaletteItem(
        { snippetId: "s1", command: "" },
        false,
        nullDecrypt,
      ),
    ).toBe("decrypt-failed");
    const throwing = deps({
      decryptSnippet: vi.fn(async () => {
        throw new Error("locked");
      }),
    });
    expect(
      await pickPaletteItem({ snippetId: "s1", command: "" }, false, throwing),
    ).toBe("decrypt-failed");
    expect(throwing.insert).not.toHaveBeenCalled();
  });

  it("missing_session_is_no_pane", async () => {
    const d = deps({ insert: vi.fn(() => "no-pane" as const) });
    expect(await pickPaletteItem({ command: "ls" }, false, d)).toBe("no-pane");
  });

  it("disconnected_pane_is_not_connected", async () => {
    const d = deps({ isConnected: vi.fn(() => false) });
    expect(await pickPaletteItem({ command: "ls" }, true, d)).toBe(
      "not-connected",
    );
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("pane_that_disconnects_during_decrypt_is_not_connected", async () => {
    const d = deps({
      isConnected: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    });
    expect(
      await pickPaletteItem({ snippetId: "s1", command: "" }, true, d),
    ).toBe("not-connected");
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("empty_is_passed_through", async () => {
    const d = deps({ insert: vi.fn(() => "empty" as const) });
    expect(await pickPaletteItem({ command: "" }, true, d)).toBe("empty");
  });

  it("unsafe_multiline_is_passed_through", async () => {
    const d = deps({ insert: vi.fn(() => "unsafe-multiline" as const) });
    expect(await pickPaletteItem({ command: "a\nb" }, false, d)).toBe(
      "unsafe-multiline",
    );
  });
});

describe("runInAllTabs", () => {
  const leaf = (id: string, connectionStatus: string, local = false) => ({
    type: "leaf" as const,
    id,
    hostName: id,
    title: id,
    connectionStatus,
    connectionType: local ? ("local" as const) : undefined,
    reconnect: null,
    size: 100,
  });
  const split = (...children: unknown[]) => ({
    type: "split" as const,
    id: "s",
    direction: "horizontal" as const,
    size: 100,
    children,
  });
  const tabs = [
    { root: leaf("a", "connected") },
    { root: split(leaf("b", "connected"), leaf("c", "reconnecting")) },
  ];

  it("runs in every connected pane in the background and counts them", () => {
    const insert = vi.fn(() => "ok" as const);
    expect(runInAllTabs("uptime", { tabs: tabs as never, insert })).toEqual({
      ran: 2,
      local: 0,
    });
    expect(insert.mock.calls).toEqual([
      ["a", "uptime", true, { focus: false, fanOut: false }],
      ["b", "uptime", true, { focus: false, fanOut: false }],
    ]);
  });

  it("counts only panes that took the command", () => {
    const insert = vi.fn((id: string) => (id === "a" ? "ok" : "no-pane"));
    expect(
      runInAllTabs("x", { tabs: tabs as never, insert: insert as never }).ran,
    ).toBe(1);
  });

  it("a broadcasting tab gets the command once per pane, never fanned out", () => {
    const insert = vi.fn(() => "ok" as const);
    const broadcasting = [
      {
        broadcast: true,
        // y connected late and isn't a broadcast target yet.
        broadcastReady: ["x", "z"],
        root: split(
          leaf("x", "connected"),
          leaf("y", "connected"),
          leaf("z", "connected"),
        ),
      },
    ];
    expect(
      runInAllTabs("uptime", { tabs: broadcasting as never, insert }),
    ).toEqual({ ran: 3, local: 0 });
    const calls = insert.mock.calls as unknown[][];
    expect(calls.map((c) => c[0])).toEqual(["x", "y", "z"]);
    for (const call of calls)
      expect(call[3]).toEqual({ focus: false, fanOut: false });
  });

  it("names local shells in the count", () => {
    const insert = vi.fn(() => "ok" as const);
    expect(
      runInAllTabs("x", {
        tabs: [{ root: leaf("l", "connected", true) }] as never,
        insert,
      }),
    ).toEqual({ ran: 1, local: 1 });
  });
});

describe("resolvePaletteCommand", () => {
  it("a snippet whose text is a status word is still a command", async () => {
    expect(
      await resolvePaletteCommand(
        { snippetId: "s1", command: "" },
        {
          decryptSnippet: async () => ({ command: "cancelled" }),
          askVariables: async () => ({}),
        },
      ),
    ).toEqual({ status: "ok", command: "cancelled" });
  });

  it("cancel and decrypt failure are statuses, not commands", async () => {
    const deps = {
      decryptSnippet: async () => ({ command: "echo {{x}}" }),
      askVariables: async () => null,
    };
    expect(
      await resolvePaletteCommand({ snippetId: "s1", command: "" }, deps),
    ).toEqual({ status: "cancelled" });
    expect(
      await resolvePaletteCommand(
        { snippetId: "s1", command: "" },
        { ...deps, decryptSnippet: async () => null },
      ),
    ).toEqual({ status: "decrypt-failed" });
  });
});
