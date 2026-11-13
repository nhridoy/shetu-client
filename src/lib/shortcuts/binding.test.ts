// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  bindingFromEvent,
  displayBinding,
  hasTypingModifier,
  isShellKey,
  isValidBinding,
  matchesBinding,
  resolveMod,
  toCodeMirrorKey,
  toTauriAccelerator,
} from "./binding";

const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe("binding helpers", () => {
  it("binding_from_event_uses_physical_key", () => {
    // AZERTY: physical KeyA produces "q"; the binding follows the position.
    expect(
      bindingFromEvent({
        ...mods,
        code: "KeyA",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe("ctrl+shift+a");
    expect(
      bindingFromEvent({
        ...mods,
        code: "Backslash",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe("ctrl+shift+backslash");
    expect(
      bindingFromEvent({ ...mods, code: "ShiftLeft", shiftKey: true }),
    ).toBeNull();
    expect(bindingFromEvent({ ...mods, code: "Digit1", altKey: true })).toBe(
      "alt+1",
    );
  });

  it("resolve_mod_per_platform", () => {
    expect(resolveMod("mod+shift+n", true)).toBe("shift+meta+n");
    expect(resolveMod("mod+shift+n", false)).toBe("ctrl+shift+n");
    expect(resolveMod("", false)).toBe("");
  });

  it("valid_bindings", () => {
    expect(isValidBinding("")).toBe(true);
    expect(isValidBinding("ctrl+shift+t")).toBe(true);
    expect(isValidBinding("f11")).toBe(true);
    expect(isValidBinding("ctrl+")).toBe(false);
    expect(isValidBinding("shift+ctrl+t")).toBe(false);
    expect(isValidBinding("ctrl+shift")).toBe(false);
    expect(isValidBinding("ctrl+ctrl+t")).toBe(false);
    expect(isValidBinding("cmd+k")).toBe(false);
    expect(isValidBinding("mod+k")).toBe(false);
    expect(isValidBinding("CTRL+k")).toBe(false);
    expect(isValidBinding("ctrl+a+b")).toBe(false);
  });

  it("display_per_platform", () => {
    expect(displayBinding("ctrl+shift+backslash", false)).toBe("Ctrl+Shift+\\");
    expect(displayBinding("shift+meta+p", true)).toBe("⇧⌘P");
    expect(displayBinding("delete", false)).toBe("Del");
    expect(displayBinding("ctrl+comma", false)).toBe("Ctrl+,");
    expect(displayBinding("f11", true)).toBe("F11");
    expect(displayBinding("", false)).toBe("");
  });

  it("codemirror_and_tauri_conversions", () => {
    expect(toCodeMirrorKey("ctrl+s")).toBe("Ctrl-s");
    expect(toCodeMirrorKey("shift+meta+s")).toBe("Shift-Meta-s");
    expect(toTauriAccelerator("shift+meta+t")).toBe("Shift+Cmd+T");
    expect(toTauriAccelerator("meta+comma")).toBe("Cmd+,");
    expect(toTauriAccelerator("")).toBeNull();
  });

  it("typing_modifier_and_shell_keys", () => {
    expect(hasTypingModifier("slash")).toBe(false);
    expect(hasTypingModifier("shift+b")).toBe(false);
    expect(hasTypingModifier("f11")).toBe(true);
    expect(hasTypingModifier("ctrl+shift+p")).toBe(true);
    expect(isShellKey("ctrl+r")).toBe(true);
    expect(isShellKey("alt+b")).toBe(true);
    expect(isShellKey("ctrl+shift+r")).toBe(false);
    expect(isShellKey("ctrl+backslash")).toBe(false);
  });

  it("matches_binding", () => {
    const e = new KeyboardEvent("keydown", {
      code: "KeyT",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(matchesBinding(e, "ctrl+shift+t")).toBe(true);
    expect(matchesBinding(e, "ctrl+t")).toBe(false);
    expect(matchesBinding(e, "")).toBe(false);
  });

  it("tauri_accelerator_names_for_named_keys", () => {
    expect(toTauriAccelerator("meta+pageup")).toBe("Cmd+PageUp");
    expect(toTauriAccelerator("meta+arrowdown")).toBe("Cmd+ArrowDown");
  });

  it("codemirror_names_for_named_keys", () => {
    expect(toCodeMirrorKey("ctrl+pageup")).toBe("Ctrl-PageUp");
    expect(toCodeMirrorKey("meta+arrowup")).toBe("Meta-ArrowUp");
    expect(toCodeMirrorKey("ctrl+delete")).toBe("Ctrl-Delete");
  });

  it("unknown_key_names_are_invalid", () => {
    expect(isValidBinding("ctrl+banana")).toBe(false);
    // Names every JS object has must not count as keys.
    expect(isValidBinding("ctrl+constructor")).toBe(false);
    expect(isValidBinding("ctrl+tostring")).toBe(false);
    expect(isValidBinding("ctrl+numpad1")).toBe(false);
    for (const ok of [
      "ctrl+pageup",
      "alt+arrowleft",
      "ctrl+space",
      "ctrl+enter",
    ])
      expect(isValidBinding(ok), ok).toBe(true);
    expect(bindingFromEvent({ ...mods, code: "CapsLock" })).toBeNull();
    expect(
      bindingFromEvent({ ...mods, code: "Numpad1", ctrlKey: true }),
    ).toBeNull();
  });
});
