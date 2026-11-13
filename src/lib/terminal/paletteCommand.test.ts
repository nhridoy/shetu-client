import { describe, expect, it, vi } from "vitest";
import { pickPaletteItem } from "./paletteCommand";

const deps = (over: Partial<Parameters<typeof pickPaletteItem>[2]> = {}) => ({
  activePaneId: "p1" as string | null,
  decryptSnippet: vi.fn(async () => ({ command: "docker ps" })),
  insert: vi.fn(() => true),
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
    const d = deps({ insert: vi.fn(() => false) });
    expect(await pickPaletteItem({ command: "ls" }, false, d)).toBe("no-pane");
  });
});
