// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  insert: vi.fn((): string => "ok"),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: { getState: () => ({ hosts: [] }) },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));
vi.mock("@/components/terminal/panes/PaneTree", () => ({
  default: () => null,
}));
vi.mock("@/lib/terminal/sessionManager", () => ({ insertIntoPane: m.insert }));
vi.mock("@/stores/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({ getDecryptedSnippet: async () => ({ command: "ls" }) }),
  },
}));
vi.mock("sonner", () => ({ toast: { error: m.error, success: m.success } }));

import {
  onOpenCommandPalette,
  terminalSnippetPicker,
} from "@/lib/terminal/paletteCommand";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import TerminalView from "./TerminalView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
let root: Root | undefined;

function withPane(connectionStatus: "connected" | "disconnected") {
  useTerminalStore.setState({
    tabs: [
      {
        id: "t1",
        title: "web",
        activePaneId: "p1",
        root: {
          type: "leaf",
          id: "p1",
          hostId: "h1",
          hostName: "web-1",
          connectionType: "ssh",
          connectionStatus,
          reconnect: null,
          size: 100,
        },
      },
    ] as never,
    activeTabId: "t1",
  });
}

function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root?.render(<TerminalView />));
}

beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  useShortcutStore.setState({ overrides: {}, recording: false });
  vi.clearAllMocks();
  withPane("connected");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
  document.body.innerHTML = "";
});

describe("TerminalView and the command palette", () => {
  it("registers its snippet picker while mounted", async () => {
    render();
    const picker = terminalSnippetPicker();
    expect(picker).not.toBeNull();
    // A pick that lands closes the palette (true).
    await expect(picker?.({ command: "pwd" }, false, false)).resolves.toBe(
      true,
    );
    expect(m.insert).toHaveBeenCalledWith("p1", "pwd", false);
    act(() => root?.unmount());
    root = undefined;
    expect(terminalSnippetPicker()).toBeNull();
  });

  it("a pick that can't land keeps the palette open with a toast", async () => {
    withPane("disconnected");
    render();
    await expect(
      terminalSnippetPicker()?.({ command: "pwd" }, false, false),
    ).resolves.toBe(false);
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.error).toHaveBeenCalledWith("This terminal isn't connected");
  });

  it("run in all tabs reports how many ran", async () => {
    render();
    await expect(
      terminalSnippetPicker()?.({ command: "uptime" }, true, true),
    ).resolves.toBe(true);
    expect(m.success).toHaveBeenCalledWith("Ran in 1 terminal");
  });

  it("Ctrl+Shift+P opens the palette filtered to snippets", () => {
    render();
    const opened = vi.fn();
    const stop = onOpenCommandPalette(opened);
    act(() => {
      for (const type of ["keydown", "keyup"])
        document.body.dispatchEvent(
          new KeyboardEvent(type, {
            key: "P",
            code: "KeyP",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        );
    });
    stop();
    expect(opened).toHaveBeenCalledWith("snippets");
  });
});
