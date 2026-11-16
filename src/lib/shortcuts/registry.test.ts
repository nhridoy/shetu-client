import { describe, expect, it } from "vitest";
import { isShellKey, isValidBinding, resolveMod } from "./binding";
import { SHORTCUTS } from "./registry";

describe("shortcut registry", () => {
  it("registry_has_31_unique_ids_with_valid_defaults", () => {
    expect(SHORTCUTS).toHaveLength(31);
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(31);
    // Focus mode was removed and Toggle sidebar never did anything.
    const ids = SHORTCUTS.map((s) => s.id as string);
    expect(ids).not.toContain("terminal.focusMode");
    expect(ids).not.toContain("terminal.toggleSidebar");
    for (const s of SHORTCUTS) {
      expect(isValidBinding(resolveMod(s.other, false)), s.id).toBe(true);
      expect(isValidBinding(resolveMod(s.mac, true)), s.id).toBe(true);
    }
  });

  it("find in terminal is Ctrl+Shift+F, Cmd+F on macOS, and works while typing", () => {
    const find = SHORTCUTS.find((s) => s.id === "terminal.find");
    expect(find).toMatchObject({
      context: "terminal",
      label: "Find in terminal",
      other: "ctrl+shift+f",
      mac: "meta+f",
      whileTyping: true,
    });
  });

  it("broadcast input is Ctrl+Shift+B, Shift+Cmd+B on macOS", () => {
    expect(SHORTCUTS.find((s) => s.id === "terminal.broadcast")).toMatchObject({
      context: "terminal",
      label: "Broadcast input",
      other: "ctrl+shift+b",
      mac: "shift+meta+b",
      whileTyping: true,
    });
  });

  it("lock shortcut is Ctrl+Shift+L, Shift+Cmd+L on macOS", () => {
    expect(SHORTCUTS.find((d) => d.id === "app.lock")).toMatchObject({
      context: "app",
      label: "Lock Shetu",
      other: "ctrl+shift+l",
      mac: "shift+meta+l",
      whileTyping: true,
    });
  });

  it("palette leaves out selection and palette shortcuts", () => {
    expect(
      SHORTCUTS.filter((d) => d.palette === false).map((d) => d.id),
    ).toEqual([
      "app.quickConnect",
      "terminal.palette",
      "terminal.copy",
      "terminal.paste",
      "files.copy",
      "files.cut",
      "files.paste",
      "files.selectAll",
      "files.rename",
      "files.delete",
      "files.up",
      "editor.copyPath",
      "editor.rename",
      "editor.delete",
    ]);
    expect(SHORTCUTS.find((d) => d.id === "app.quickConnect")?.label).toBe(
      "Command palette",
    );
  });

  it("defaults_have_no_conflicts_within_a_context", () => {
    for (const mac of [false, true]) {
      const seen = new Map<string, string>();
      for (const s of SHORTCUTS) {
        const b = resolveMod(mac ? s.mac : s.other, mac);
        if (!b) continue;
        const key = `${s.context}:${b}`;
        expect(seen.get(key), `${s.id} vs ${seen.get(key)}`).toBeUndefined();
        seen.set(key, s.id);
      }
    }
  });

  it("linux_terminal_defaults_leave_shell_keys_alone", () => {
    for (const s of SHORTCUTS.filter(
      (d) => d.whileTyping && (d.context === "app" || d.context === "terminal"),
    ))
      expect(isShellKey(resolveMod(s.other, false)), s.id).toBe(false);
  });
});
