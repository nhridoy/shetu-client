// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  hosts: [] as unknown[],
  snippets: [] as unknown[],
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: () => ({ hosts: m.hosts }),
}));
vi.mock("@/stores/terminal/shellStore", () => ({
  useShellStore: (pick: (s: { shells: unknown[] }) => unknown) =>
    pick({ shells: [] }),
}));
vi.mock("@/stores/snippets/snippetStore", () => ({
  useSnippetStore: (pick: (s: { snippets: unknown[] }) => unknown) =>
    pick({ snippets: m.snippets }),
}));
vi.mock("@/components/snippets/RunOnHostsDialog", () => ({
  default: ({ snippet }: { snippet: { name: string } }) => (
    <div data-testid="run-on-hosts">{snippet.name}</div>
  ),
}));

import { registerShortcutHandler } from "@/lib/shortcuts/actions";
import {
  onOpenPortForwarding,
  openCommandPalette,
  setTerminalSnippetPicker,
} from "@/lib/terminal/paletteCommand";
import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { useTerminalStore } from "@/stores/terminal/terminalStore";
import CommandPalette from "./CommandPalette";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realPlatform = navigator.platform;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  useShortcutStore.setState({ overrides: {}, activeContext: null });
  m.hosts = [];
  m.snippets = [];
});
afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: realPlatform,
    configurable: true,
  });
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = "";
});

function setup() {
  const onConnect = vi.fn();
  const onNavigate = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = () =>
    act(() =>
      root.render(
        <CommandPalette onConnect={onConnect} onNavigate={onNavigate} />,
      ),
    );
  rerender();
  cleanups.push(() => act(() => root.unmount()));
  const press = (init: KeyboardEventInit) =>
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, ...init }),
      );
    });
  const input = () => document.querySelector("input") as HTMLInputElement;
  const isOpen = () => input() !== null;
  const open = () =>
    press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (k: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
  const text = () => document.body.textContent ?? "";
  return {
    press,
    isOpen,
    open,
    type,
    key,
    text,
    input,
    rerender,
    onConnect,
    onNavigate,
  };
}

describe("CommandPalette shortcut", () => {
  it("quick_connect_opens_on_ctrl_shift_k", () => {
    const { isOpen, open } = setup();
    expect(isOpen()).toBe(false);
    open();
    expect(isOpen()).toBe(true);
  });

  it("plain_ctrl_k_no_longer_opens_quick_connect", () => {
    const { press, isOpen } = setup();
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(isOpen()).toBe(false);
  });

  it("quick_connect_follows_a_rebinding", async () => {
    await act(() =>
      useShortcutStore.getState().setBinding("app.quickConnect", "ctrl+alt+k"),
    );
    const { press, isOpen } = setup();
    press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(isOpen()).toBe(true);
  });

  it("quick_connect_leaves_keys_the_editor_handled", () => {
    const { isOpen } = setup();
    // The code editor binds Ctrl+Shift+K to "delete line" and marks the event handled.
    const editor = document.createElement("div");
    editor.addEventListener("keydown", (e) => e.preventDefault());
    document.body.append(editor);
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "K",
          code: "KeyK",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(isOpen()).toBe(false);
  });
});

describe("CommandPalette picks", () => {
  it("connects to a host and to a typed user@host:port", async () => {
    m.hosts = [
      {
        id: "h1",
        name: "web-1",
        address: "10.0.0.4",
        port: 22,
        tags: [],
        sortOrder: 0,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const p = setup();
    p.open();
    expect(p.text()).toContain("Enter to connect");
    await p.key("Enter");
    expect(p.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "h1" }),
    );
    expect(p.isOpen()).toBe(false);
    p.open();
    p.type("root@1.2.3.4:2222");
    await p.key("Enter");
    expect(p.onConnect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: "1.2.3.4",
        port: 2222,
        username: "root",
      }),
    );
  });

  it("runs a live action of the open view and closes", async () => {
    useShortcutStore.setState({ activeContext: "terminal" });
    const find = vi.fn();
    cleanups.push(registerShortcutHandler("terminal.find", find));
    // In the terminal the snippet picker is registered too; built-ins mustn't shadow actions.
    cleanups.push(setTerminalSnippetPicker(vi.fn(async () => true)));
    const p = setup();
    p.open();
    p.type("find");
    await p.key("Enter");
    expect(find).toHaveBeenCalledTimes(1);
    expect(p.isOpen()).toBe(false);
  });

  it("goes to a page and opens a create form", async () => {
    const p = setup();
    p.open();
    p.type("keychain");
    await p.key("Enter");
    expect(p.onNavigate).toHaveBeenCalledWith("/keys");
    p.open();
    p.type("new host");
    await p.key("Enter");
    expect(p.onNavigate).toHaveBeenLastCalledWith("/hosts?new=host");
  });

  it("in the terminal, snippet keys insert, run, or run in all tabs", async () => {
    m.snippets = [{ id: "s1", name: "restart nginx", tags: [] }];
    let done = false;
    const picker = vi.fn(async () => done);
    cleanups.push(setTerminalSnippetPicker(picker));
    useShortcutStore.setState({ activeContext: "terminal" });
    const p = setup();
    act(() => openCommandPalette("snippets"));
    expect(p.text()).toContain(
      "Enter to insert · Ctrl+Enter to run · Ctrl+Shift+Enter to run in all tabs",
    );
    const item = { snippetId: "s1", command: "" };
    await p.key("Enter");
    expect(picker).toHaveBeenLastCalledWith(item, false, false);
    // The picker failed: the palette stays open.
    expect(p.isOpen()).toBe(true);
    await p.key("Enter", { ctrlKey: true });
    expect(picker).toHaveBeenLastCalledWith(item, true, false);
    done = true;
    await p.key("Enter", { ctrlKey: true, shiftKey: true });
    expect(picker).toHaveBeenLastCalledWith(item, true, true);
    expect(p.isOpen()).toBe(false);
  });

  it("outside the terminal, a snippet opens Run on hosts", async () => {
    m.snippets = [{ id: "s1", name: "restart nginx", tags: [] }];
    const p = setup();
    p.open();
    p.type("restart");
    expect(p.text()).toContain("Enter to run on hosts");
    await p.key("Enter");
    expect(
      document.querySelector('[data-testid="run-on-hosts"]')?.textContent,
    ).toBe("restart nginx");
  });

  it("the snippets filter resets on the next plain open", () => {
    m.snippets = [{ id: "s1", name: "restart nginx", tags: [] }];
    useShortcutStore.setState({ activeContext: "terminal" });
    cleanups.push(registerShortcutHandler("terminal.find", () => {}));
    const p = setup();
    act(() => openCommandPalette("snippets"));
    expect(p.input().placeholder).toBe("Search snippets");
    expect(p.text()).not.toContain("Find in terminal");
    act(() => openCommandPalette());
    expect(p.text()).toContain("Find in terminal");
  });

  it("port forwarding opens the active connected SSH pane's panel", async () => {
    useShortcutStore.setState({ activeContext: "terminal" });
    const leaf = (over: object) => ({
      type: "leaf" as const,
      id: "p1",
      hostId: "h1",
      hostName: "web-1",
      connectionType: "ssh" as const,
      connectionStatus: "connected" as const,
      reconnect: null,
      size: 100,
      ...over,
    });
    const setPane = (over: object) =>
      useTerminalStore.setState({
        tabs: [
          { id: "t1", title: "web", root: leaf(over), activePaneId: "p1" },
        ] as never,
        activeTabId: "t1",
      });
    const opened = vi.fn();
    cleanups.push(onOpenPortForwarding(opened));
    setPane({});
    const p = setup();
    p.open();
    p.type("port");
    expect(p.text()).toContain("Port forwarding");
    await p.key("Enter");
    expect(opened).toHaveBeenCalledWith("p1");
    for (const over of [
      { connectionType: "local" },
      { connectionStatus: "disconnected" },
    ]) {
      setPane(over);
      p.open();
      p.type("port");
      expect(p.text()).not.toContain("Port forwarding");
      await p.key("Escape");
    }
  });

  it("Enter confirming an IME candidate doesn't pick", async () => {
    const p = setup();
    p.open();
    p.type("keychain");
    await p.key("Enter", { isComposing: true });
    expect(p.onNavigate).not.toHaveBeenCalled();
    expect(p.isOpen()).toBe(true);
  });

  it("the selected row scrolls into view", async () => {
    const scrolled: string[] = [];
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function () {
      scrolled.push(this.textContent ?? "");
    };
    cleanups.push(() => {
      HTMLElement.prototype.scrollIntoView = orig;
    });
    const p = setup();
    p.open();
    p.type("go to");
    await p.key("ArrowDown");
    expect(scrolled.at(-1)).toContain("Go to Workspaces");
  });

  it("is a labelled combobox whose selected option screen readers can follow", async () => {
    const p = setup();
    p.open();
    p.type("go to");
    const input = p.input();
    expect(input.getAttribute("aria-label")).toBe(
      "Search hosts, actions and snippets",
    );
    expect(input.getAttribute("role")).toBe("combobox");
    const list = document.getElementById(
      input.getAttribute("aria-controls") ?? "",
    );
    expect(list?.getAttribute("role")).toBe("listbox");
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    await p.key("ArrowDown");
    const active = document.getElementById(
      input.getAttribute("aria-activedescendant") ?? "",
    );
    expect(active?.textContent).toContain("Go to Workspaces");
    expect(active?.getAttribute("aria-selected")).toBe("true");
  });

  it("the selection stays on a row when the list gets shorter", async () => {
    const host = (i: number) => ({
      id: `h${i}`,
      name: `web-${i}`,
      address: `10.0.0.${i}`,
      port: 22,
      tags: [],
      sortOrder: i,
      createdAt: "",
      updatedAt: "",
    });
    m.hosts = [host(1), host(2), host(3)];
    useShortcutStore.setState({ activeContext: null });
    const p = setup();
    p.open();
    p.type("web");
    await p.key("ArrowDown");
    await p.key("ArrowDown");
    // A sync removes hosts while the palette is open.
    m.hosts = [host(1)];
    p.rerender();
    const selected = document.querySelectorAll(
      '[role="option"][aria-selected="true"]',
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("web-1");
    expect(p.text()).toContain("Enter to connect");
  });

  it("the open shortcut closes it again", () => {
    const p = setup();
    p.open();
    expect(p.isOpen()).toBe(true);
    p.open();
    expect(p.isOpen()).toBe(false);
  });

  it("Ctrl+Shift+P toggles the snippets view, and switches to it from the full palette", () => {
    const p = setup();
    act(() => openCommandPalette("snippets"));
    expect(p.isOpen()).toBe(true);
    act(() => openCommandPalette("snippets"));
    expect(p.isOpen()).toBe(false);
    p.open();
    act(() => openCommandPalette("snippets"));
    expect(p.input().placeholder).toBe("Search snippets");
  });
});
