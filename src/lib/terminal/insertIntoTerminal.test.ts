// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// sessionManager's store imports subscribe to Tauri events at load time.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { insertIntoPane, insertIntoTerminal } from "./sessionManager";

const fakeTerm = (bracketedPasteMode = true) => {
  const calls: string[] = [];
  return {
    calls,
    modes: { bracketedPasteMode },
    paste: vi.fn((d: string) => calls.push(`paste:${d}`)),
    input: vi.fn((d: string) => calls.push(`input:${d}`)),
    focus: vi.fn(() => calls.push("focus")),
  };
};

describe("insertIntoTerminal", () => {
  it("trims_trailing_newlines so inserting never runs the command", () => {
    const t = fakeTerm();
    insertIntoTerminal(t, "ls -la\r\n\n", false);
    expect(t.paste).toHaveBeenCalledWith("ls -la");
    expect(t.input).not.toHaveBeenCalled();
  });

  it("multi_line_is_one_paste", () => {
    const t = fakeTerm();
    insertIntoTerminal(t, "a\nb", false);
    expect(t.paste).toHaveBeenCalledTimes(1);
    expect(t.paste).toHaveBeenCalledWith("a\nb");
  });

  it("run_sends_enter_after_paste", () => {
    const t = fakeTerm();
    insertIntoTerminal(t, "uptime", true);
    expect(t.calls.slice(0, 2)).toEqual(["paste:uptime", "input:\r"]);
  });

  it("focuses_terminal", () => {
    const t = fakeTerm();
    insertIntoTerminal(t, "uptime", false);
    expect(t.focus).toHaveBeenCalled();
  });
});

describe("insertIntoTerminal safety", () => {
  it("refuses_to_insert_multi_line_without_bracketed_paste", () => {
    const t = fakeTerm(false);
    expect(insertIntoTerminal(t, "cd /srv\ngit reset --hard", false)).toBe(
      "unsafe-multiline",
    );
    expect(t.paste).not.toHaveBeenCalled();
  });

  it("multi_line_run_is_allowed_without_bracketed_paste", () => {
    const t = fakeTerm(false);
    expect(insertIntoTerminal(t, "a\nb", true)).toBe("ok");
    expect(t.paste).toHaveBeenCalledWith("a\nb");
  });

  it("single_line_insert_is_fine_without_bracketed_paste", () => {
    const t = fakeTerm(false);
    expect(insertIntoTerminal(t, "uptime", false)).toBe("ok");
  });

  it("strips_paste_escape_and_control_characters", () => {
    const t = fakeTerm();
    insertIntoTerminal(t, "echo hi\x1b[201~; rm -rf /tmp/x\x07", false);
    expect(t.paste).toHaveBeenCalledWith("echo hi[201~; rm -rf /tmp/x");
  });
});

describe("insertIntoTerminal empty", () => {
  it("empty_command_sends_nothing_not_even_enter", () => {
    const t = fakeTerm();
    expect(insertIntoTerminal(t, "\n\x07", true)).toBe("empty");
    expect(t.paste).not.toHaveBeenCalled();
    expect(t.input).not.toHaveBeenCalled();
  });
});

describe("insertIntoPane", () => {
  it("missing_session_returns_false", () => {
    expect(insertIntoPane("nope", "ls", false)).toBe("no-pane");
  });
});
