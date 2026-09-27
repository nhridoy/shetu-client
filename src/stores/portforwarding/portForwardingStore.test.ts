import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForwardInput, ForwardView } from "./portForwardingStore";
import { usePortForwardingStore } from "./portForwardingStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  statusHandler: null as
    | null
    | ((event: {
        payload: {
          id: string;
          status: { state: "stopped" | "active" | "failed"; error?: string };
        };
      }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const input: ForwardInput = {
  hostId: "host-1",
  mode: "local",
  name: "web",
  localPort: 8080,
  remoteBindAddress: null,
  remotePort: null,
  destinationHost: "localhost",
  destinationPort: 80,
};
const view: ForwardView = {
  definition: { id: "forward-1", ...input },
  status: { state: "stopped" },
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listen.mockImplementation(async (_name, handler) => {
    mocks.statusHandler = handler;
    return () => undefined;
  });
  usePortForwardingStore.setState({
    hostId: null,
    forwards: [],
    isLoading: false,
    error: null,
    busyIds: [],
  });
});

describe("portForwardingStore", () => {
  it("loads saved forwards without starting them", async () => {
    mocks.invoke.mockResolvedValueOnce([view]);
    await usePortForwardingStore.getState().loadForwards("host-1");
    expect(mocks.invoke).toHaveBeenCalledWith("list_port_forwards", {
      hostId: "host-1",
    });
    expect(usePortForwardingStore.getState().forwards[0].status.state).toBe(
      "stopped",
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves each host's forwards when split panes load separately", async () => {
    const otherView: ForwardView = {
      definition: {
        ...view.definition,
        id: "forward-2",
        hostId: "host-2",
      },
      status: { state: "stopped" },
    };
    mocks.invoke
      .mockResolvedValueOnce([view])
      .mockResolvedValueOnce([otherView])
      .mockResolvedValueOnce([]);
    await usePortForwardingStore.getState().loadForwards("host-1");
    await usePortForwardingStore.getState().loadForwards("host-2");
    expect(
      usePortForwardingStore.getState().forwards.map((item) => item.id),
    ).toEqual(["forward-1", "forward-2"]);
    await usePortForwardingStore.getState().loadForwards("host-1");
    expect(
      usePortForwardingStore.getState().forwards.map((item) => item.id),
    ).toEqual(["forward-2"]);
  });

  it("saves a definition without connecting", async () => {
    usePortForwardingStore.setState({ hostId: "host-1" });
    mocks.invoke.mockResolvedValueOnce(view);
    await usePortForwardingStore.getState().createForward(input);
    expect(mocks.invoke).toHaveBeenCalledWith("create_port_forward", { input });
    expect(usePortForwardingStore.getState().forwards[0].status.state).toBe(
      "stopped",
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed start inactive and exposes its error", async () => {
    usePortForwardingStore.setState({
      hostId: "host-1",
      forwards: [{ ...view.definition, status: view.status }],
    });
    mocks.invoke.mockRejectedValueOnce("Address already in use");
    await expect(
      usePortForwardingStore.getState().startForward("forward-1", "pane-1"),
    ).rejects.toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("start_port_forward", {
      id: "forward-1",
      ownerPaneId: "pane-1",
    });
    expect(usePortForwardingStore.getState().forwards[0].status).toEqual({
      state: "failed",
      error: "Address already in use",
    });
  });

  it("updates, stops, and deletes through their respective commands", async () => {
    usePortForwardingStore.setState({
      hostId: "host-1",
      forwards: [{ ...view.definition, status: view.status }],
    });
    mocks.invoke
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce(undefined);
    await usePortForwardingStore.getState().updateForward("forward-1", input);
    await usePortForwardingStore.getState().stopForward("forward-1");
    await usePortForwardingStore.getState().deleteForward("forward-1");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "update_port_forward", {
      id: "forward-1",
      input,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "stop_port_forward", {
      id: "forward-1",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "delete_port_forward", {
      id: "forward-1",
    });
    expect(usePortForwardingStore.getState().forwards).toEqual([]);
  });

  it("updates live status without resurrecting deleted definitions", async () => {
    mocks.invoke.mockResolvedValueOnce([view]);
    await usePortForwardingStore.getState().loadForwards("host-1");
    mocks.statusHandler?.({
      payload: { id: "forward-1", status: { state: "active" } },
    });
    expect(usePortForwardingStore.getState().forwards[0].status.state).toBe(
      "active",
    );
    usePortForwardingStore.setState({ forwards: [] });
    mocks.statusHandler?.({
      payload: {
        id: "forward-1",
        status: { state: "failed", error: "Disconnected" },
      },
    });
    expect(usePortForwardingStore.getState().forwards).toEqual([]);
  });
});
