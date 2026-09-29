import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { getDeviceId } from "./device";

describe("device ID", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the previously enrolled auth.json UUID", async () => {
    const id = "7a8e3145-4790-4d4f-a889-56f493253306";
    vi.mocked(load).mockResolvedValue({ get: vi.fn(async () => id) } as never);
    expect(await getDeviceId()).toBe(id);
    expect(invoke).not.toHaveBeenCalled();
  });
});
