// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import SshTab from "./SshTab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("toggles trusting new hosts", async () => {
  const setTrustNewHosts = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <SshTab
        knownHosts={[]}
        knownHostsLoading={false}
        onLoadKnownHosts={() => {}}
        onRemoveKnownHost={() => {}}
        onClearAllKnownHosts={() => {}}
        trustNewHosts={false}
        setTrustNewHosts={setTrustNewHosts}
      />,
    ),
  );
  expect(container.textContent).toContain("Trust new hosts automatically");
  expect(container.textContent).toContain(
    "Skip the fingerprint check the first time you connect to a server. Changed keys still ask.",
  );
  const box = container.querySelector<HTMLElement>("#trust-new-hosts");
  await act(async () => box?.click());
  expect(setTrustNewHosts).toHaveBeenCalledWith(true);
  act(() => root.unmount());
});
