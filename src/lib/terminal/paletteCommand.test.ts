import { describe, expect, it, vi } from "vitest";
import { pickPaletteItem, runInAllTabs } from "./paletteCommand";

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
  const leaf = (id: string, connectionStatus: string) => ({
    type: "leaf" as const,
    id,
    hostName: id,
    title: id,
    connectionStatus,
    reconnect: null,
    size: 100,
  });
  const tabs = [
    { root: leaf("a", "connected") },
    {
      root: {
        type: "split" as const,
        id: "s",
        direction: "horizontal" as const,
        size: 100,
        children: [leaf("b", "connected"), leaf("c", "reconnecting")],
      },
    },
  ];

  it("runs in every connected pane and counts them", () => {
    const insert = vi.fn(() => "ok" as const);
    expect(runInAllTabs("uptime", { tabs: tabs as never, insert })).toBe(2);
    expect(insert.mock.calls).toEqual([
      ["a", "uptime", true],
      ["b", "uptime", true],
    ]);
  });

  it("counts only panes that took the command", () => {
    const insert = vi.fn((id: string) => (id === "a" ? "ok" : "no-pane"));
    expect(
      runInAllTabs("x", { tabs: tabs as never, insert: insert as never }),
    ).toBe(1);
  });
});
