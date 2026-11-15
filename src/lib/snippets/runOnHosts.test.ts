import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  run: vi.fn(),
  ask: vi.fn(
    async (): Promise<Record<string, string> | null> => ({ svc: "nginx" }),
  ),
  decrypt: vi.fn(
    async (): Promise<{ command: string } | null> => ({
      command: "systemctl restart {{svc}}",
    }),
  ),
}));
vi.mock("@/lib/terminal/runWhenConnected", () => ({ runWhenConnected: m.run }));
vi.mock("@/stores/snippets/snippetVariablesStore", () => ({
  askSnippetVariables: m.ask,
}));
vi.mock("@/stores/snippets/snippetStore", () => ({
  useSnippetStore: { getState: () => ({ getDecryptedSnippet: m.decrypt }) },
}));
vi.mock("@/stores/hosts/hostStore", () => ({
  useHostStore: {
    getState: () => ({
      hosts: [
        { id: "h1", name: "web-1" },
        { id: "h2", name: "web-2" },
      ],
    }),
  },
}));
vi.mock("@/stores/sessions/tabGroupStore", () => ({
  useTabGroupStore: { getState: vi.fn() },
}));
vi.mock("@/stores/workspaces/workspaceStore", () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));

import { useTerminalStore } from "@/stores/terminal/terminalStore";
import { runOnHosts } from "./runOnHosts";

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
  m.run.mockClear();
  m.ask.mockClear();
});

describe("runOnHosts", () => {
  it("opens a tab per host and runs the same filled command in each", async () => {
    expect(await runOnHosts("s1", ["h1", "h2"])).toBe("ok");
    const tabs = useTerminalStore.getState().tabs;
    expect(tabs.map((t) => t.title)).toEqual(["web-1", "web-2"]);
    expect(m.ask).toHaveBeenCalledTimes(1);
    expect(m.run.mock.calls).toEqual([
      [tabs[0].id, tabs[0].activePaneId, "systemctl restart nginx"],
      [tabs[1].id, tabs[1].activePaneId, "systemctl restart nginx"],
    ]);
  });

  it("cancel sends nothing", async () => {
    m.ask.mockResolvedValueOnce(null);
    expect(await runOnHosts("s1", ["h1"])).toBe("cancelled");
    expect(useTerminalStore.getState().tabs).toHaveLength(0);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("needs at least one known host, and a readable snippet", async () => {
    expect(await runOnHosts("s1", [])).toBe("no-hosts");
    expect(await runOnHosts("s1", ["gone"])).toBe("no-hosts");
    m.decrypt.mockResolvedValueOnce(null);
    expect(await runOnHosts("s1", ["h1"])).toBe("decrypt-failed");
    expect(useTerminalStore.getState().tabs).toHaveLength(0);
  });
});
