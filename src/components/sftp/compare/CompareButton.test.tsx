// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useSftpStore } from "@/stores/sftp/sftpStore";
import CompareButton from "./CompareButton";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompareButton", () => {
  it("renders without an update loop and compares with the other pane", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    useSftpStore.setState({
      root: {
        type: "split",
        id: "s",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "L", connectionType: "local", size: 50 },
          {
            type: "leaf",
            id: "R",
            connectionType: "host",
            hostId: "h1",
            size: 50,
          },
        ],
      } as never,
      compare: null,
    });
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () => root.render(<CompareButton paneId="L" />));
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Compare",
    );
    await act(async () => button?.click());
    expect(useSftpStore.getState().compare).toEqual({
      leftPaneId: "L",
      rightPaneId: "R",
    });
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(
      /Maximum update depth|getSnapshot should be cached/,
    );
    act(() => root.unmount());
    errors.mockRestore();
  });
});
