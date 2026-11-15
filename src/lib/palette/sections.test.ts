import { describe, expect, it } from "vitest";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { Host } from "@/stores/hosts/hostStore";
import { buildPaletteSections, type PaletteSection } from "./sections";

const host = (i: number): Host => ({
  id: `h${i}`,
  name: `web-${i}`,
  address: `10.0.0.${i}`,
  port: 22,
  tags: [],
  sortOrder: i,
  createdAt: "",
  updatedAt: "",
});

const base = {
  query: "",
  mode: "all" as const,
  hosts: [] as Host[],
  shells: [],
  snippets: [],
  builtins: null,
  live: new Set<ShortcutId>(),
  activeContext: null,
  portForwardingPaneId: null,
};

const titles = (s: PaletteSection[]) => s.map((x) => x.title);
const labels = (s: PaletteSection[], title: string) =>
  (s.find((x) => x.title === title)?.rows ?? []).map((r) =>
    "label" in r ? r.label : r.kind === "host" ? r.host.name : r.kind,
  );

describe("buildPaletteSections", () => {
  it("caps an empty query at 8 rows per section, but not a search", () => {
    const hosts = Array.from({ length: 10 }, (_, i) => host(i + 1));
    expect(
      labels(buildPaletteSections({ ...base, hosts }), "Hosts"),
    ).toHaveLength(8);
    const found = buildPaletteSections({ ...base, hosts, query: "web" });
    expect(labels(found, "Hosts").filter((l) => l !== "direct")).toHaveLength(
      10,
    );
    expect(
      labels(
        buildPaletteSections({ ...base, hosts, query: "10.0.0.4" }),
        "Hosts",
      ),
    ).toEqual(["web-4"]);
  });

  it("offers a direct connection when no host matches exactly", () => {
    const s = buildPaletteSections({
      ...base,
      hosts: [host(1)],
      query: "root@x",
    });
    expect(s[0].rows[0]).toEqual({ kind: "direct", query: "root@x" });
  });

  it("finds snippets by tag and lists built-ins after them only when given", () => {
    const snippets = [{ id: "s1", name: "restart", tags: ["Nginx"] }];
    const builtins = [
      { name: "pwd", command: "pwd", description: "Print dir" },
    ];
    expect(
      labels(
        buildPaletteSections({ ...base, snippets, query: "nginx" }),
        "Snippets",
      ),
    ).toEqual(["restart"]);
    expect(
      labels(
        buildPaletteSections({ ...base, snippets, builtins, mode: "snippets" }),
        "Snippets",
      ),
    ).toEqual(["restart", "pwd"]);
    expect(
      labels(buildPaletteSections({ ...base, snippets }), "Snippets"),
    ).toEqual(["restart"]);
  });

  it("built-ins are listed only when filtering to snippets", () => {
    const builtins = [
      { name: "find", command: "find ", description: "Find files" },
    ];
    expect(
      labels(
        buildPaletteSections({ ...base, builtins, query: "find" }),
        "Snippets",
      ),
    ).toEqual([]);
    expect(
      labels(
        buildPaletteSections({
          ...base,
          builtins,
          query: "find",
          mode: "snippets",
        }),
        "Snippets",
      ),
    ).toEqual(["find"]);
  });

  it("snippets mode shows only snippets", () => {
    const s = buildPaletteSections({
      ...base,
      mode: "snippets",
      hosts: [host(1)],
      snippets: [{ id: "s1", name: "restart", tags: [] }],
      live: new Set<ShortcutId>(["app.settings"]),
    });
    expect(titles(s)).toEqual(["Snippets"]);
  });

  it("lists live actions of the open view and app-wide ones, never palette: false", () => {
    const live = new Set<ShortcutId>([
      "terminal.find",
      "terminal.copy",
      "app.settings",
    ]);
    const inTerminal = labels(
      buildPaletteSections({ ...base, live, activeContext: "terminal" }),
      "Actions",
    );
    expect(inTerminal).toContain("Find in terminal");
    expect(inTerminal).toContain("Settings");
    expect(inTerminal).not.toContain("Copy");
    const elsewhere = labels(
      buildPaletteSections({ ...base, live }),
      "Actions",
    );
    expect(elsewhere).not.toContain("Find in terminal");
    expect(elsewhere).toContain("Settings");
    expect(
      labels(
        buildPaletteSections({ ...base, activeContext: "terminal" }),
        "Actions",
      ),
    ).not.toContain("Find in terminal");
  });

  it("pages, create actions and port forwarding", () => {
    const keych = buildPaletteSections({ ...base, query: "keych" });
    expect(keych.find((x) => x.title === "Actions")?.rows).toEqual([
      { kind: "page", path: "/keys", label: "Go to Keychain" },
    ]);
    expect(
      labels(buildPaletteSections({ ...base, query: "new" }), "Actions"),
    ).toEqual(["New host", "New group", "New snippet", "New key"]);
    expect(
      labels(buildPaletteSections({ ...base, query: "port" }), "Actions"),
    ).toEqual([]);
    expect(
      buildPaletteSections({
        ...base,
        query: "port",
        portForwardingPaneId: "p1",
      })[0].rows,
    ).toEqual([
      { kind: "portForwarding", paneId: "p1", label: "Port forwarding" },
    ]);
  });

  it("orders sections and omits empty ones", () => {
    const s = buildPaletteSections({
      ...base,
      hosts: [host(1)],
      shells: [{ name: "bash", path: "/bin/bash" }],
      snippets: [{ id: "s1", name: "x", tags: [] }],
    });
    expect(titles(s)).toEqual(["Hosts", "Local shells", "Snippets", "Actions"]);
    expect(titles(buildPaletteSections({ ...base, query: "zzz" }))).toEqual([]);
    // Address-like text offers a direct connection; a plain word doesn't.
    expect(titles(buildPaletteSections({ ...base, query: "a.b" }))).toEqual([
      "Hosts",
    ]);
  });
});
