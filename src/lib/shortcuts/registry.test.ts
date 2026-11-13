import { describe, expect, it } from "vitest";
import { isShellKey, isValidBinding, resolveMod } from "./binding";
import { SHORTCUTS } from "./registry";

describe("shortcut registry", () => {
  it("registry_has_28_unique_ids_with_valid_defaults", () => {
    expect(SHORTCUTS).toHaveLength(28);
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(28);
    // Focus mode was removed and Toggle sidebar never did anything.
    const ids = SHORTCUTS.map((s) => s.id as string);
    expect(ids).not.toContain("terminal.focusMode");
    expect(ids).not.toContain("terminal.toggleSidebar");
    for (const s of SHORTCUTS) {
      expect(isValidBinding(resolveMod(s.other, false)), s.id).toBe(true);
      expect(isValidBinding(resolveMod(s.mac, true)), s.id).toBe(true);
    }
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
