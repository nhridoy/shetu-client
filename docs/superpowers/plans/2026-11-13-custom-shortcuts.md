# Customizable Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every shortcut the app defines itself is changeable from a Settings → Keyboard tab, saved on the device, applied immediately, reflected in menus, and never leaked to the shell.

**Architecture:** One registry lists all 30 shortcuts (id, context, per-platform default, focus rule). A zustand store holds the user's overrides (persisted under `shortcuts` in `settings.json`) and answers effective binding, conflicts, shell warnings and "hold back from the terminal". Handlers call a thin `useShortcut(id, cb)` wrapper over `react-hotkeys-hook`; xterm's key filter, CodeMirror's save keymap, menu labels and the macOS menu bar all read the same effective bindings.

**Tech Stack:** React 19, TypeScript, zustand, `@tauri-apps/plugin-store`, `react-hotkeys-hook@5.3.3`, xterm 6, CodeMirror 6, Tauri v2 (Rust) menu API, vitest + happy-dom, Biome.

**Spec:** `docs/superpowers/specs/2026-11-13-custom-shortcuts-design.md`

## Global Constraints

- Dependency: `react-hotkeys-hook` pinned **exactly** `5.3.3` (`bun add react-hotkeys-hook@5.3.3 --exact`). No other new dependencies.
- Bindings match the **physical key** (`event.code`); never `event.key`. Library option `useKey` stays `false`.
- Canonical binding string: lowercase, modifiers in the order `ctrl+alt+shift+meta+<key>`, `<key>` = `event.code` lowercased with a leading `key`/`digit` removed (`KeyT`→`t`, `Backslash`→`backslash`, `Comma`→`comma`, `Slash`→`slash`, `F11`→`f11`). `""` = no binding. Registry defaults may use `mod` (Cmd on macOS, Ctrl elsewhere); it is resolved before use.
- Defaults (Linux/Windows · macOS) are exactly the spec's Contexts table; file browser and editor use `mod+…`. "Save workspace" does not exist.
- Platform check: `navigator.platform.includes("Mac")` (as the rest of the app). macOS-menu presence: `hasMacMenu()` from `src/lib/window/menuActions.ts`.
- Saved overrides live under the key `shortcuts` in the `settings.json` plugin-store file; only overrides are stored; unknown ids / invalid values are ignored on load.
- Commits: conventional messages, **no AI/Claude attribution of any kind**.
- Checks before every commit: `npx vitest run <task tests>`; before each task-done: `npx vitest run`, `npx tsc --noEmit -p .`, `npx biome check src`. Task 7 also: `cargo test --manifest-path src-tauri/Cargo.toml menu`.

## Review Focus

1. A corrupt `shortcuts` value in `settings.json` (a string, an array, an unknown id, an invalid binding like `"ctrl+"`) must leave every shortcut on its default — pinned in Task 2 (`load_ignores_corrupt_values`).
2. A bare-key binding in a not-while-typing context (`/` for Search hosts) must never be held back from the terminal, or `/` becomes untypeable — pinned in Task 2 (`slash_is_never_held_back`).
3. Pressing a combination while the Keyboard tab is recording must not also trigger the shortcut it currently belongs to (recording Ctrl+Shift+T must not open a tab) — pinned in Task 8 (`recording_does_not_trigger_shortcuts`).
4. A rebinding takes effect immediately: the new key fires, the old key no longer does, without reload — pinned in Task 3 (`rebinding_applies_immediately`).
5. An empty binding disables the shortcut everywhere: it never fires, isn't held back, shows no menu label, and removes the macOS accelerator — pinned in Tasks 2, 3, 6, 7 (`empty_binding_*`).

---

### Task 1: Registry and binding helpers

**Files:**
- Create: `src/lib/shortcuts/registry.ts`, `src/lib/shortcuts/binding.ts`
- Test: `src/lib/shortcuts/binding.test.ts`, `src/lib/shortcuts/registry.test.ts`

**Interfaces:**
- Produces (`registry.ts`):
  ```ts
  export type ShortcutContext = "app" | "terminal" | "files" | "editor";
  export interface ShortcutDef {
    id: ShortcutId; context: ShortcutContext; label: string;
    other: string;        // default on Linux/Windows (may use "mod")
    mac: string;          // default on macOS (may use "mod"); "" = none
    whileTyping: boolean; // fires in inputs and the terminal
    menuItem?: "new-tab" | "close-tab" | "quick-connect" | "settings"; // macOS menu-bar item
    macFixed?: boolean;   // shown but not rebindable on macOS
  }
  export type ShortcutId = "app.quickConnect" | "app.settings" | "app.searchHosts"
    | "terminal.newTab" | "terminal.closePane" | "terminal.nextTab" | "terminal.prevTab"
    | "terminal.splitRight" | "terminal.splitDown" | "terminal.focusMode" | "terminal.palette"
    | "terminal.toggleSidebar" | "terminal.copy" | "terminal.paste"
    | "files.copy" | "files.cut" | "files.paste" | "files.newFile" | "files.newFolder"
    | "files.selectAll" | "files.rename" | "files.refresh" | "files.delete" | "files.up"
    | "editor.quickOpen" | "editor.toggleFiles" | "editor.save" | "editor.copyPath"
    | "editor.rename" | "editor.delete";
  export const SHORTCUTS: readonly ShortcutDef[];
  export const CONTEXT_LABELS: Record<ShortcutContext, string>; // "App-wide", "Terminal", "File browser", "Editor"
  ```
  Values: the spec's Contexts table. `whileTyping` true for all `terminal.*`, `app.quickConnect`, `app.settings`, `editor.quickOpen`, `editor.save`; false otherwise. `menuItem` on `terminal.newTab`, `terminal.closePane`, `app.quickConnect`, `app.settings`. `macFixed` on `terminal.copy`, `terminal.paste` (mac default `""`).
- Produces (`binding.ts`):
  ```ts
  export function resolveMod(binding: string, mac: boolean): string;       // "mod+c" → "meta+c" | "ctrl+c", canonical order
  export function bindingFromEvent(e: Pick<KeyboardEvent,"code"|"ctrlKey"|"altKey"|"shiftKey"|"metaKey">): string | null; // null for modifier-only presses
  export function isValidBinding(b: string): boolean;                      // "" or canonical with a non-modifier key
  export function matchesBinding(e: KeyboardEvent, binding: string): boolean; // false for ""
  export function displayBinding(binding: string, mac: boolean): string;   // "" → ""
  export function toCodeMirrorKey(binding: string): string;               // "ctrl+s" → "Ctrl-s"
  export function toTauriAccelerator(binding: string): string | null;     // "meta+shift+t" → "Cmd+Shift+T"; "" → null
  export function hasTypingModifier(binding: string): boolean;            // ctrl/alt/meta present, or key is f1–f24
  export function isShellKey(binding: string): boolean;                   // plain ctrl+<letter> or alt+<letter> (shift allowed with alt only)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// binding.test.ts
it("binding_from_event_uses_physical_key", () => {
  // AZERTY: physical KeyA produces "q" — the binding follows the position.
  expect(bindingFromEvent({ code: "KeyA", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe("ctrl+shift+a");
  expect(bindingFromEvent({ code: "Backslash", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe("ctrl+shift+backslash");
  expect(bindingFromEvent({ code: "ShiftLeft", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBeNull();
  expect(bindingFromEvent({ code: "Digit1", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false })).toBe("alt+1");
});
it("resolve_mod_per_platform", () => {
  expect(resolveMod("mod+shift+n", true)).toBe("shift+meta+n");
  expect(resolveMod("mod+shift+n", false)).toBe("ctrl+shift+n");
  expect(resolveMod("", false)).toBe("");
});
it("valid_bindings", () => {
  expect(isValidBinding("")).toBe(true);
  expect(isValidBinding("ctrl+shift+t")).toBe(true);
  expect(isValidBinding("ctrl+")).toBe(false);
  expect(isValidBinding("shift+ctrl+t")).toBe(false); // not canonical order
  expect(isValidBinding("ctrl+shift")).toBe(false);
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
  expect(isShellKey("ctrl+r")).toBe(true);
  expect(isShellKey("alt+b")).toBe(true);
  expect(isShellKey("ctrl+shift+r")).toBe(false);
  expect(isShellKey("ctrl+backslash")).toBe(false);
});
it("matches_binding", () => {
  const e = new KeyboardEvent("keydown", { code: "KeyT", ctrlKey: true, shiftKey: true });
  expect(matchesBinding(e, "ctrl+shift+t")).toBe(true);
  expect(matchesBinding(e, "ctrl+t")).toBe(false);
  expect(matchesBinding(e, "")).toBe(false);
});

// registry.test.ts
it("registry_has_30_unique_ids_with_valid_defaults", () => {
  expect(SHORTCUTS).toHaveLength(30);
  expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(30);
  for (const s of SHORTCUTS) {
    expect(isValidBinding(resolveMod(s.other, false))).toBe(true);
    expect(isValidBinding(resolveMod(s.mac, true))).toBe(true);
  }
});
it("defaults_have_no_conflicts_within_a_context", () => { /* per platform, per context: resolved defaults (non-empty) are unique */ });
it("linux_terminal_defaults_leave_shell_keys_alone", () => {
  for (const s of SHORTCUTS.filter((d) => d.whileTyping && (d.context === "app" || d.context === "terminal")))
    expect(isShellKey(resolveMod(s.other, false))).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/shortcuts` — Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `registry.ts` and `binding.ts`** with the signatures above. Display key labels: letters/digits uppercase, `f1`–`f24` as `F11`, `backslash` `\`, `comma` `,`, `slash` `/`, `period` `.`, `minus` `-`, `equal` `=`, `tab` `Tab`, `delete` `Del`, `backspace` `Backspace`, `enter` `Enter`, `space` `Space`, `pageup`/`pagedown` `PgUp`/`PgDn`, others capitalised. macOS symbols in order `⌃⌥⇧⌘`; elsewhere `Ctrl+Alt+Shift+Meta+`.
- [ ] **Step 4: Run** `npx vitest run src/lib/shortcuts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): registry of app shortcuts and binding helpers`

---

### Task 2: Shortcut store (overrides, persistence, queries)

**Files:**
- Create: `src/stores/shortcuts/shortcutStore.ts`
- Modify: `src/App.tsx` (call `initShortcuts()` beside `initSettings()`)
- Test: `src/stores/shortcuts/shortcutStore.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SHORTCUTS`, `ShortcutId`, `ShortcutContext`, `resolveMod`, `isValidBinding`, `matchesBinding`, `isShellKey`).
- Produces:
  ```ts
  export interface ShortcutState {
    overrides: Partial<Record<ShortcutId, string>>;
    activeContext: ShortcutContext | null; // the mounted view: "terminal" | "files" | "editor" | null
    recording: boolean;                    // Keyboard tab is capturing keys: all shortcuts pause
    initShortcuts(): Promise<void>;
    setBinding(id: ShortcutId, binding: string): Promise<void>; // "" = none; equal to default → override removed
    resetBinding(id: ShortcutId): Promise<void>;
    resetAll(): Promise<void>;
    setActiveContext(c: ShortcutContext | null): void;
    setRecording(on: boolean): void;
  }
  export const useShortcutStore: UseBoundStore<StoreApi<ShortcutState>>;
  export function effectiveBinding(id: ShortcutId, s?: Pick<ShortcutState,"overrides">, mac?: boolean): string; // resolved, canonical
  export function findConflict(id: ShortcutId, binding: string, mac?: boolean): ShortcutId | null;
  export function shadowedAppShortcut(id: ShortcutId, mac?: boolean): ShortcutId | null; // view binding equal to an app-wide one ("overrides X here")
  export function isHeldBackFromTerminal(e: KeyboardEvent, mac?: boolean): boolean;
  export function isShortcutDisabled(id: ShortcutId): boolean; // empty binding, or recording, or (mac && hasMacMenu() && def.menuItem)
  ```
  `mac` defaults to `navigator.platform.includes("Mac")`.
  Conflict rule: same context; `app` conflicts with every context except when the other binding is in a view context and the app one is not menu-owned on macOS (then it is a shadow, not a conflict — `shadowedAppShortcut` reports it). On macOS a `menuItem` shortcut conflicts with every context.
  Held back: any non-empty effective binding of a `whileTyping` shortcut in `app` or `terminal` that matches `e`.

- [ ] **Step 1: Write the failing tests** (mock `@tauri-apps/plugin-store` `load` with an in-memory `{ get, set, save }`; reset store between tests)

```ts
it("defaults_apply_without_overrides", () => {
  expect(effectiveBinding("terminal.newTab", { overrides: {} }, false)).toBe("ctrl+shift+t");
  expect(effectiveBinding("terminal.newTab", { overrides: {} }, true)).toBe("meta+t");
  expect(effectiveBinding("files.copy", { overrides: {} }, true)).toBe("meta+c");
});
it("set_binding_persists_only_overrides", async () => {
  await useShortcutStore.getState().setBinding("terminal.palette", "ctrl+alt+p");
  expect(saved.shortcuts).toEqual({ "terminal.palette": "ctrl+alt+p" });
  await useShortcutStore.getState().setBinding("terminal.palette", "ctrl+shift+p"); // back to default
  expect(saved.shortcuts).toEqual({});
});
it("load_ignores_corrupt_values", async () => {
  for (const bad of ["ctrl+t", ["x"], { "nope.id": "ctrl+x", "terminal.newTab": "ctrl+", "files.copy": 5 }]) {
    saved.shortcuts = bad;
    await useShortcutStore.getState().initShortcuts();
    expect(effectiveBinding("terminal.newTab", undefined, false)).toBe("ctrl+shift+t");
    expect(effectiveBinding("files.copy", undefined, false)).toBe("ctrl+c");
  }
});
it("load_failure_keeps_defaults", async () => { /* load() rejects → overrides {} */ });
it("conflicts_are_per_context", () => {
  expect(findConflict("files.copy", "ctrl+x", false)).toBe("files.cut");
  expect(findConflict("editor.copyPath", "ctrl+x", false)).toBeNull(); // other context
  expect(findConflict("terminal.palette", "ctrl+shift+k", false)).toBe("app.quickConnect"); // app vs terminal is a conflict
});
it("view_binding_shadows_app_wide", () => {
  useShortcutStore.setState({ overrides: { "editor.quickOpen": "ctrl+shift+k" } });
  expect(findConflict("editor.quickOpen", "ctrl+shift+k", false)).toBeNull();
  expect(shadowedAppShortcut("editor.quickOpen", false)).toBe("app.quickConnect");
});
it("mac_menu_items_conflict_everywhere", () => {
  expect(findConflict("editor.quickOpen", "meta+t", true)).toBe("terminal.newTab");
});
it("held_back_from_terminal", () => {
  const ev = (code: string, mods: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { code, ...mods });
  expect(isHeldBackFromTerminal(ev("KeyT", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  expect(isHeldBackFromTerminal(ev("Backslash", { ctrlKey: true }), false)).toBe(true);
  expect(isHeldBackFromTerminal(ev("KeyW", { ctrlKey: true }), false)).toBe(false); // shell keeps Ctrl+W
});
it("slash_is_never_held_back", () => {
  expect(isHeldBackFromTerminal(new KeyboardEvent("keydown", { code: "Slash" }), false)).toBe(false);
});
it("empty_binding_disables_and_is_not_held_back", async () => {
  await useShortcutStore.getState().setBinding("terminal.splitRight", "");
  expect(isShortcutDisabled("terminal.splitRight")).toBe(true);
  expect(isHeldBackFromTerminal(new KeyboardEvent("keydown", { code: "Backslash", ctrlKey: true }), false)).toBe(false);
});
it("recording_disables_everything", () => {
  useShortcutStore.getState().setRecording(true);
  expect(isShortcutDisabled("app.quickConnect")).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run src/stores/shortcuts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement the store** following `settingsStore.ts`'s load/save pattern (`load("settings.json", { autoSave: false })`, key `shortcuts`, best-effort save). Add `initShortcuts()` to `App.tsx`'s init effect.
- [ ] **Step 4: Run** `npx vitest run src/stores/shortcuts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): store saved bindings with conflict and terminal checks`

---

### Task 3: `useShortcut` + terminal view + terminal key filter

**Files:**
- Create: `src/hooks/useShortcut.ts`, `src/hooks/useShortcutContext.ts`
- Modify: `package.json`/`bun.lock` (add `react-hotkeys-hook@5.3.3 --exact`), `src/hooks/useKeyboardShortcuts.ts` (rewrite on `useShortcut`; delete `defaultShortcuts`, `KeyboardShortcut`, `onSaveWorkspace`), `src/components/terminal/views/TerminalView.tsx` (drop `onSaveWorkspace`; call `useShortcutContext("terminal")`), `src/lib/terminal/terminalKeys.ts`
- Delete: `src/components/settings/modal/KeyboardSettings.tsx` (orphaned; Task 8 replaces it)
- Test: `src/hooks/useKeyboardShortcuts.test.tsx` (update), `src/hooks/useShortcut.test.tsx`, `src/lib/terminal/terminalKeys.test.ts` (update)

**Interfaces:**
- Consumes: Task 2 (`useShortcutStore`, `effectiveBinding`, `isShortcutDisabled`, `isHeldBackFromTerminal`), Task 1 (`SHORTCUTS`).
- Produces:
  ```ts
  // useShortcut.ts
  export function useShortcut(
    id: ShortcutId,
    callback: (e: KeyboardEvent) => void,
    options?: { enabled?: boolean; capture?: boolean },
  ): void;
  ```
  Wraps `useHotkeys(binding, cb, { enabled, enableOnFormTags: def.whileTyping, enableOnContentEditable: def.whileTyping, preventDefault: true, eventListenerOptions: { capture: !!options?.capture } })`. Re-renders on store change (subscribe to `overrides`, `recording`). Disabled when `isShortcutDisabled(id)` or `options.enabled === false`. For `context === "app"` it is also disabled while `shadowedAppShortcut` names it for the current `activeContext`.
  ```ts
  // useShortcutContext.ts — sets activeContext on mount, null on unmount
  export function useShortcutContext(context: Exclude<ShortcutContext, "app">): void;
  ```
  `useKeyboardShortcuts` keeps its props minus `onSaveWorkspace`; each prop maps to its `terminal.*` id.
  `handleTerminalKey(e, term, mac)`: returns `false` when `isHeldBackFromTerminal(e, mac)`; runs copy/paste when `e` matches `terminal.copy` / `terminal.paste` effective bindings (keydown only, `preventDefault`); otherwise `true`. The hard-coded Ctrl+\ / Ctrl+Shift+C/V rules go.

- [ ] **Step 1: Write / update the failing tests**

```ts
// useKeyboardShortcuts.test.tsx — Linux platform
it("new_tab_is_ctrl_shift_t", () => { press({ code: "KeyT", key: "T", ctrlKey: true, shiftKey: true }); expect(h.onNewTab).toHaveBeenCalledTimes(1); });
it("plain_ctrl_t_is_left_to_the_shell", () => { press({ code: "KeyT", key: "t", ctrlKey: true }); expect(h.onNewTab).not.toHaveBeenCalled(); });
it("rebinding_applies_immediately", async () => {
  await act(() => useShortcutStore.getState().setBinding("terminal.newTab", "alt+n"));
  press({ code: "KeyN", key: "n", altKey: true });
  press({ code: "KeyT", key: "T", ctrlKey: true, shiftKey: true });
  expect(h.onNewTab).toHaveBeenCalledTimes(1);
});
it("fires_while_typing_in_the_terminal", () => { /* dispatch on a focused <textarea> (xterm's input): Ctrl+Shift+P calls onCommandPalette */ });
it("empty_binding_never_fires", async () => { /* setBinding("terminal.splitRight", "") → Ctrl+\ does nothing */ });
// keep: ctrl_backslash_splits_right_only, ctrl_shift_backslash_splits_down_only, ctrl_shift_tab_goes_back_one_tab, ctrl_tab_goes_forward_one_tab

// terminalKeys.test.ts
it("app_shortcuts_are_held_back", () => { expect(handleTerminalKey(key({ code: "KeyT", ctrlKey: true, shiftKey: true }), t, false)).toBe(false); });
it("ctrl_w_reaches_the_shell", () => { expect(handleTerminalKey(key({ code: "KeyW", ctrlKey: true }), t, false)).toBe(true); });
it("rebound_copy_key_copies", async () => { /* setBinding("terminal.copy", "ctrl+alt+c") → that key copies; Ctrl+Shift+C now reaches xterm (true) */ });
// keep: ctrl_shift_c_copies_the_selection, ctrl_shift_c_without_a_selection_copies_nothing, ctrl_shift_v_pastes_once, ctrl_backslash_is_kept_from_the_shell, other_keys_reach_the_shell
// replace macos_keeps_its_own_keys with: macos_copy_paste_have_no_binding (Ctrl+Shift+C on mac → true, nothing copied)
```

- [ ] **Step 2: Run** `npx vitest run src/hooks src/lib/terminal` — Expected: FAIL (new defaults / modules missing).
- [ ] **Step 3: Add the dependency and implement** `useShortcut`, `useShortcutContext`, the `useKeyboardShortcuts` rewrite, `handleTerminalKey`; delete `KeyboardSettings.tsx`.
- [ ] **Step 4: Run** `npx vitest run src/hooks src/lib/terminal` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): terminal shortcuts read saved bindings and stay out of the shell`

---

### Task 4: App-wide shortcuts (Quick Connect, Settings, Search hosts)

**Files:**
- Modify: `src/components/terminal/views/QuickConnect.tsx` (replace `classifyQuickConnectKey` use with `useShortcut("app.quickConnect", open, { capture: true })`; keep its Escape handling and the app-action listener), `src/components/layout/shell/Layout.tsx` (`useShortcut("app.settings", () => settingsModal.show())`), `src/components/hosts/panels/HostsPanel.tsx` (`useShortcut("app.searchHosts", focus search)`), `src/lib/window/menuActions.ts` (delete `classifyQuickConnectKey`, `isMenuOwnedShortcut`, `MENU_OWNED_KEYS` once unused — menu ownership now comes from `isShortcutDisabled`)
- Test: `src/lib/window/menuActions.test.ts` (drop removed-function tests), `src/components/terminal/views/QuickConnect.test.tsx` (create or extend), `src/components/hosts/panels/HostsPanel.test.tsx` (extend if present, else create a focused test)

**Interfaces:**
- Consumes: Task 3 (`useShortcut`), Task 2 (`isShortcutDisabled` handles macOS menu ownership).

- [ ] **Step 1: Write the failing tests**

```ts
it("quick_connect_opens_on_ctrl_shift_k", () => { /* Linux: press code KeyK ctrl+shift → panel open */ });
it("plain_ctrl_k_no_longer_opens_quick_connect", () => { /* Linux: ctrl+k → closed */ });
it("quick_connect_follows_a_rebinding", () => { /* setBinding("app.quickConnect","ctrl+alt+k") → that key opens */ });
it("settings_opens_on_ctrl_comma", () => { /* Layout or a minimal harness around the same hook */ });
it("slash_focuses_host_search_but_not_while_typing", () => { /* "/" on body focuses search; "/" inside an input types */ });
```

- [ ] **Step 2: Run** the new/updated test files — Expected: FAIL.
- [ ] **Step 3: Implement** the three call sites and remove the now-unused helpers from `menuActions.ts` (update `useKeyboardShortcuts` if it still imports them).
- [ ] **Step 4: Run** the same tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): Quick Connect, Settings and host search use saved bindings`

---

### Task 5: File browser and editor shortcuts

**Files:**
- Modify: `src/hooks/sftp/useFileKeyboardShortcuts.ts` (each action via `useShortcut("files.*", …, { enabled: paneActive && !deleteConfirm && !pasteConflicts })`; Rename/Delete keep their selection checks inside the callback; the dialog Enter/Escape handling and Escape-clears-selection stay as they are), `src/components/sftp/browser/FileBrowser.tsx` and `src/components/sftp/browser/LocalFileBrowser.tsx` (call `useShortcutContext("files")` once at page level — whichever component is the page root; `src/pages/SftpPage.tsx` is fine), `src/components/editor/views/EditorLayout.tsx` (`useShortcutContext("editor")`; Quick open and Toggle file list via `useShortcut`, Quick open `capture: true`), `src/components/editor/panels/EditorExplorer.tsx` (Rename/Delete/Copy path via the element-scoped form of the library — `useHotkeys` returns a ref; attach it to the explorer's focusable list — Enter stays in `onKeyDown`), `src/components/editor/views/EditorView.tsx` (save keymap key = `toCodeMirrorKey(effectiveBinding("editor.save"))`; none when empty; `useMemo` depends on the binding so the editor reconfigures)
- Test: `src/hooks/sftp/useFileKeyboardShortcuts.test.tsx` (create), `src/components/editor/views/editorSaveKey.test.ts` (create; test the keymap-building function extracted from `EditorView.tsx` as `saveKeymapFor(binding: string, onSave: () => void): Extension | null`)

**Interfaces:**
- Consumes: Task 3 (`useShortcut`, `useShortcutContext`), Task 1 (`toCodeMirrorKey`), Task 2 (`effectiveBinding`).
- Produces: `saveKeymapFor(binding: string, onSave: () => void): Extension | null` exported from `src/components/editor/views/EditorView.tsx` (or a sibling `editorSaveKey.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
it("files_copy_uses_mod_c_and_not_while_typing", () => { /* ctrl+c on body → onCopy; inside <input> → not */ });
it("files_rename_needs_one_selected", () => { /* F2 with 2 selected → onRename not called */ });
it("files_shortcuts_pause_during_delete_confirm", () => { /* deleteConfirm set → ctrl+c does nothing; Enter confirms */ });
it("files_inactive_pane_ignores_keys", () => { /* activePaneId !== paneId → nothing */ });
it("files_follow_a_rebinding", () => { /* setBinding("files.refresh","ctrl+r") → ctrl+r refreshes, F5 doesn't */ });
it("save_keymap_follows_binding", () => {
  expect(saveKeymapFor("", vi.fn())).toBeNull();
  // run the keymap's binding via CodeMirror's runScopeHandlers on a minimal EditorView, or assert the produced key string
});
```

- [ ] **Step 2: Run** `npx vitest run src/hooks/sftp src/components/editor` — Expected: FAIL.
- [ ] **Step 3: Implement** the call-site changes above.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): file browser and editor use saved bindings`

---

### Task 6: Menu labels show the current binding

**Files:**
- Modify: `src/lib/terminal/terminalContextMenu.ts` (Copy, Paste, Snippets…, Split Right, Split Down), `src/components/sftp/browser/shared/buildBaseContextMenuItems.tsx` (Copy, Cut, Paste, New Folder, New File, Rename, Delete), `src/components/sftp/browser/LocalFileBrowser.tsx` (Refresh F5), `src/components/editor/panels/explorerMenu.ts` (Rename, Delete)
- Test: `src/lib/terminal/terminalContextMenu.test.ts` (update), plus one label test per other file's existing test, or a new focused test

**Interfaces:**
- Consumes: `displayBinding(effectiveBinding(id), mac)`. An empty binding → no `shortcut` field.

- [ ] **Step 1: Update / write the failing tests**

```ts
it("shows_shortcuts_that_work_on_each_platform", () => {
  expect(shortcuts("Linux x86_64")).toMatchObject({ Copy: "Ctrl+Shift+C", Paste: "Ctrl+Shift+V", "Snippets…": "Ctrl+Shift+P", "Split Right": "Ctrl+\\", "Split Down": "Ctrl+Shift+\\" });
  expect(shortcuts("MacIntel")).toMatchObject({ Copy: undefined, Paste: undefined, "Snippets…": "⇧⌘P", "Split Right": "⌘\\", "Split Down": "⇧⌘\\" });
});
it("labels_follow_a_rebinding", () => { /* setBinding("terminal.palette","ctrl+alt+p") → "Ctrl+Alt+P" */ });
it("empty_binding_has_no_label", () => { /* setBinding("terminal.splitRight","") → shortcut undefined */ });
it("file_menu_labels_follow_bindings", () => { /* Linux: Copy "Ctrl+C", New Folder "Ctrl+Shift+N"; after rebinding files.copy → new label */ });
```

  Note: macOS Copy/Paste in the terminal menu now show no label (they are `macFixed` with no binding); the system Edit menu shows ⌘C/⌘V.

- [ ] **Step 2: Run** the label tests — Expected: FAIL.
- [ ] **Step 3: Implement** — replace every hard-coded `shortcut:` string in the listed files.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shortcuts): menu labels show the current bindings`

---

### Task 7: macOS menu bar follows bindings

**Files:**
- Modify: `src-tauri/src/menu.rs` (keep handles to the four items in managed state; add `#[tauri::command] fn set_menu_accelerators(app: AppHandle, accelerators: HashMap<String, Option<String>>) -> Result<(), String>`; unknown ids ignored; `None` removes the accelerator; on non-macOS the command is registered but returns `Ok(())` without touching anything), `src-tauri/src/lib.rs` (register the command), create `src/lib/shortcuts/macMenu.ts` (`syncMacMenu(): Promise<void>` — when `hasMacMenu()`, invoke with `{ "new-tab": toTauriAccelerator(effectiveBinding("terminal.newTab")), "close-tab": …closePane, "quick-connect": …, "settings": … }`), `src/stores/shortcuts/shortcutStore.ts` (call `syncMacMenu()` after `initShortcuts` and after every change)
- Test: `src/lib/shortcuts/macMenu.test.ts`; Rust: unit test in `menu.rs` for the id→item lookup / unknown-id handling that does not need a running app (e.g. a pure `fn accelerator_updates(input) -> Vec<(&'static str, Option<String>)>` filtering to the four known ids)

**Interfaces:**
- Consumes: Task 1 (`toTauriAccelerator`), Task 2 (`effectiveBinding`).
- Produces: Tauri command `set_menu_accelerators` with argument `accelerators: Record<string, string | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("syncs_the_four_menu_items_on_macos", async () => {
  // hasMacMenu() → true (mock), invoke mocked
  await syncMacMenu();
  expect(invoke).toHaveBeenCalledWith("set_menu_accelerators", { accelerators: { "new-tab": "Cmd+T", "close-tab": "Cmd+W", "quick-connect": "Cmd+K", settings: "Cmd+," } });
});
it("empty_binding_removes_the_accelerator", async () => { /* setBinding("terminal.newTab","") → "new-tab": null */ });
it("does_nothing_without_the_mac_menu", async () => { /* hasMacMenu() false → invoke not called */ });
```
```rust
#[test]
fn accelerator_updates_keep_only_known_items() { /* {"new-tab": Some("Cmd+T"), "bogus": Some("X")} → only new-tab */ }
```

- [ ] **Step 2: Run** `npx vitest run src/lib/shortcuts/macMenu.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml menu` — Expected: FAIL.
- [ ] **Step 3: Implement** (Tauri v2: `MenuItem::set_accelerator(Option<&str>)`).
- [ ] **Step 4: Run** both — Expected: PASS; also `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` clean.
- [ ] **Step 5: Commit** `feat(shortcuts): macOS menu bar follows saved bindings`

---

### Task 8: Settings → Keyboard tab

**Files:**
- Create: `src/components/settings/tabs/KeyboardTab.tsx`
- Modify: `src/components/settings/modal/SettingsTabs.tsx` (add `{ id: "keyboard", label: "Keyboard", icon: <KeyboardIcon className="w-4 h-4" /> }` after Terminal), `src/components/settings/modal/SettingsPanel.tsx` (extend `activeTab` union, render `<KeyboardTab />`)
- Test: `src/components/settings/tabs/KeyboardTab.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`SHORTCUTS`, `CONTEXT_LABELS`, `displayBinding`, `bindingFromEvent`, `hasTypingModifier`, `isShellKey`), Task 2 (store actions, `effectiveBinding`, `findConflict`, `shadowedAppShortcut`, `setRecording`).

Behaviour (copy fixed here):
- Sections per context in order App-wide, Terminal, File browser, Editor; row = label + key cap (`displayBinding`, or "None" when empty). macOS `macFixed` rows show "⌘C"/"⌘V" as plain text with "System", not clickable.
- Click key cap → "Press keys…"; `setRecording(true)`; a capture-phase `keydown` listener on `window` calls `preventDefault` + `stopPropagation`; Escape cancels; modifier-only presses keep waiting; `setRecording(false)` when done.
- Bare key in a `whileTyping` shortcut → inline error "Add Ctrl, Alt or Cmd — this shortcut works while you type." (macOS: "Add ⌘, ⌥ or ⌃ — …"); not saved.
- Conflict → "Already used by <label>." with **Replace** (clears the other to `""`, saves this) and **Cancel**.
- Shell key (`isShellKey`) in `app`/`terminal` → saved, with warning under the row: "The terminal won't receive <key>."
- Shadow → note under the row: "Overrides <app label> in the <context label>."
- Row actions: "Reset" (only when overridden), "Clear" (sets `""`). Footer: "Reset all".

- [ ] **Step 1: Write the failing tests**

```ts
it("lists_every_shortcut_by_context", () => { /* 4 headings; 30 rows on Linux */ });
it("records_a_new_binding", async () => { /* click New tab cap → press alt+n → store override "alt+n"; cap shows "Alt+N" */ });
it("recording_does_not_trigger_shortcuts", () => {
  // render KeyboardTab alongside a component using useKeyboardShortcuts({ onNewTab })
  // click New tab cap, press Ctrl+Shift+T → onNewTab not called; binding unchanged (equal to default)
});
it("escape_cancels_recording", () => {});
it("bare_key_refused_where_typing", () => { /* Snippets palette ← "p" → error copy, nothing saved */ });
it("conflict_offers_replace", async () => { /* files.copy ← ctrl+x → "Already used by Cut." → Replace → files.cut "" and files.copy "ctrl+x" */ });
it("shell_key_warns_but_saves", () => { /* terminal.palette ← ctrl+r → saved + "The terminal won't receive Ctrl+R." */ });
it("reset_and_clear", () => { /* Clear → "None"; Reset → default; Reset all → overrides {} */ });
it("mac_copy_paste_rows_are_fixed", () => { /* MacIntel: Copy row not a button, shows ⌘C */ });
```

- [ ] **Step 2: Run** `npx vitest run src/components/settings` — Expected: FAIL.
- [ ] **Step 3: Implement** the tab in the existing Settings tab style (match `TerminalTab`'s section/row markup and `Button` variants).
- [ ] **Step 4: Run** — Expected: PASS. Then the full checks: `npx vitest run`, `npx tsc --noEmit -p .`, `npx biome check src`.
- [ ] **Step 5: Commit** `feat(settings): Keyboard tab to change shortcuts`
