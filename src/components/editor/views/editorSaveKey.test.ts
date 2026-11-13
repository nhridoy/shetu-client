// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { saveKeymapFor } from "./editorSaveKey";

function editorWith(binding: string, onSave: () => void) {
  const ext = saveKeymapFor(binding, onSave);
  return new EditorView({
    state: EditorState.create({ extensions: ext ? [ext] : [] }),
    parent: document.body,
  });
}

const press = (view: EditorView, init: KeyboardEventInit) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor");

describe("saveKeymapFor", () => {
  it("save_keymap_follows_binding", () => {
    const onSave = vi.fn();
    const view = editorWith("ctrl+alt+s", onSave);
    expect(press(view, { key: "s", ctrlKey: true })).toBe(false);
    expect(press(view, { key: "s", ctrlKey: true, altKey: true })).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("empty_binding_has_no_keymap", () => {
    expect(saveKeymapFor("", vi.fn())).toBeNull();
  });
});
