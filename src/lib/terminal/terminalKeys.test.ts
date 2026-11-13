import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { handleTerminalKey } from "./terminalKeys";

function terminal(selection = "") {
  return {
    hasSelection: vi.fn(() => selection !== ""),
    getSelection: vi.fn(() => selection),
    paste: vi.fn(),
    focus: vi.fn(),
  };
}

const key = (init: Partial<KeyboardEvent>) =>
  ({
    type: "keydown",
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...init,
  }) as unknown as KeyboardEvent;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  clipboard.readText.mockResolvedValue("ls -la");
  clipboard.writeText.mockResolvedValue(undefined);
});

describe("handleTerminalKey", () => {
  it("ctrl_shift_c_copies_the_selection", () => {
    const term = terminal("hello");
    const e = key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(handleTerminalKey(e, term, false)).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("ctrl_shift_c_without_a_selection_copies_nothing", () => {
    const term = terminal();
    const e = key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(handleTerminalKey(e, term, false)).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("ctrl_shift_v_pastes_once", async () => {
    const term = terminal();
    const down = key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    const up = { ...down, type: "keyup" } as KeyboardEvent;
    expect(handleTerminalKey(down, term, false)).toBe(false);
    expect(handleTerminalKey(up, term, false)).toBe(false);
    await flush();
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(term.paste).toHaveBeenCalledWith("ls -la");
  });

  it("ctrl_backslash_is_kept_from_the_shell", () => {
    const e = key({ key: "\\", code: "Backslash", ctrlKey: true });
    expect(handleTerminalKey(e, terminal(), false)).toBe(false);
  });

  it("other_keys_reach_the_shell", () => {
    const t = terminal();
    expect(
      handleTerminalKey(
        key({ key: "c", code: "KeyC", ctrlKey: true }),
        t,
        false,
      ),
    ).toBe(true);
    expect(handleTerminalKey(key({ key: "a", code: "KeyA" }), t, false)).toBe(
      true,
    );
  });

  it("macos_keeps_its_own_keys", () => {
    const t = terminal("x");
    // Cmd+C/V go through the Edit menu; Ctrl+\ is the shell's on a Mac.
    expect(
      handleTerminalKey(
        key({ key: "\\", code: "Backslash", ctrlKey: true }),
        t,
        true,
      ),
    ).toBe(true);
    expect(
      handleTerminalKey(
        key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
        t,
        true,
      ),
    ).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
