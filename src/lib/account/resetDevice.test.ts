// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const fail = vi.hoisted(() => ({ invoke: false }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (file: string) => ({
    get: async () => undefined,
    set: async () => {},
    clear: async () => {
      calls.push(`clear:${file}`);
    },
    save: async () => {
      calls.push(`save:${file}`);
    },
  })),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(`invoke:${cmd}`);
    if (fail.invoke) throw new Error("disk locked");
    return ["known_hosts"];
  }),
}));

import { useShortcutStore } from "@/stores/shortcuts/shortcutStore";
import { resetDevice } from "./resetDevice";

const teardown = async () => {
  calls.push("teardown");
};

describe("resetDevice", () => {
  beforeEach(() => {
    calls.length = 0;
    fail.invoke = false;
    localStorage.setItem("x", "1");
  });

  it("reset_runs_every_step_in_order", async () => {
    const failures = await resetDevice(teardown);
    const i = (s: string) => calls.indexOf(s);
    expect(calls[0]).toBe("teardown");
    expect(i("save:settings.json")).toBeGreaterThan(0);
    expect(i("save:team-cache.json")).toBeGreaterThan(i("save:settings.json"));
    expect(i("invoke:reset_device_files")).toBeGreaterThan(
      i("save:team-cache.json"),
    );
    expect(localStorage.getItem("x")).toBeNull();
    expect(failures).toEqual(["known_hosts"]);
  });

  it("reset_reports_failures_the_teardown_returns", async () => {
    const failures = await resetDevice(async () => ["local data: locked"]);
    expect(failures).toContain("local data: locked");
  });

  it("reset_continues_after_a_failing_step", async () => {
    fail.invoke = true;
    useShortcutStore.setState({ overrides: { a: "b" } as never });
    const failures = await resetDevice(async () => {
      throw new Error("boom");
    });
    expect(failures).toHaveLength(2);
    expect(calls).toContain("save:team-cache.json");
    expect(useShortcutStore.getState().overrides).toEqual({});
  });

  it("reset_clears_shortcut_overrides", async () => {
    useShortcutStore.setState({ overrides: { a: "b" } as never });
    await resetDevice(teardown);
    expect(useShortcutStore.getState().overrides).toEqual({});
  });
});
