// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Avatar", () => {
  it("falls back from the provider picture to Gravatar to initials", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Avatar
          id="u1"
          name="Nahid Hridoy"
          email="nahid@example.com"
          avatarUrl="https://avatars.example.com/n.png"
        />,
      ),
    );
    const img = () => container.querySelector("img");
    expect(img()?.getAttribute("src")).toBe(
      "https://avatars.example.com/n.png",
    );

    await act(async () => img()?.dispatchEvent(new Event("error")));
    expect(img()?.getAttribute("src")).toMatch(
      /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=48&d=404$/,
    );

    await act(async () => img()?.dispatchEvent(new Event("error")));
    expect(img()).toBeNull();
    expect(container.textContent).toBe("NH");
    act(() => root.unmount());
  });
});
