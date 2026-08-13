import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockHostStore = vi.hoisted(() => ({
  getDecryptedHost: vi.fn(),
  getCredentialsForHost: vi.fn(),
  updateHostOs: vi.fn(),
}));

vi.mock("./hostStore", () => ({
  useHostStore: { getState: () => mockHostStore },
}));

import { useHostPingStore } from "./hostPingStore";

const mockInvoke = vi.mocked(
  (await import("@tauri-apps/api/core")).invoke as unknown as ReturnType<
    typeof vi.fn
  >,
);

describe("hostPingStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHostPingStore.setState({ pings: {} });
    mockHostStore.getDecryptedHost.mockResolvedValue({
      address: "1.2.3.4",
      port: 22,
      username: "root",
    });
    mockHostStore.getCredentialsForHost.mockResolvedValue({
      password: "pw",
      privateKey: "",
      passphrase: "",
    });
  });

  it("reachable result stores latency, saves os, updates host", async () => {
    mockInvoke.mockResolvedValue({
      reachable: true,
      latency_ms: 23,
      os: "ubuntu",
    });
    await useHostPingStore.getState().ping("h1");
    const ping = useHostPingStore.getState().pings.h1;
    expect(ping.status).toBe("reachable");
    expect(ping.latencyMs).toBe(23);
    expect(ping.os).toBe("ubuntu");
    expect(mockHostStore.updateHostOs).toHaveBeenCalledWith("h1", "ubuntu");
  });

  it("unreachable result never calls updateHostOs", async () => {
    mockInvoke.mockResolvedValue({
      reachable: false,
      latency_ms: null,
      os: null,
    });
    await useHostPingStore.getState().ping("h1");
    expect(useHostPingStore.getState().pings.h1.status).toBe("unreachable");
    expect(mockHostStore.updateHostOs).not.toHaveBeenCalled();
  });

  it("host without address is unreachable without invoking", async () => {
    mockHostStore.getDecryptedHost.mockResolvedValue(null);
    await useHostPingStore.getState().ping("h1");
    expect(useHostPingStore.getState().pings.h1.status).toBe("unreachable");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invoke failure degrades to unreachable", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"));
    await useHostPingStore.getState().ping("h1");
    expect(useHostPingStore.getState().pings.h1.status).toBe("unreachable");
  });
});
