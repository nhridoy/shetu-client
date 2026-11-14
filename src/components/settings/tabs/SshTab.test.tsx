// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import SshTab from "./SshTab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sshProps = {
  sshKeepaliveSecs: 30,
  sshConnectTimeoutSecs: 10,
  sshTerminalType: "xterm-256color" as const,
  sshAgentPath: "",
  onSshSettingChange: () => {},
};

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
        {...sshProps}
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

async function mount(onSshSettingChange = vi.fn()) {
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
        setTrustNewHosts={() => {}}
        {...sshProps}
        onSshSettingChange={onSshSettingChange}
      />,
    ),
  );
  return { container, root };
}

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("renders the SSH default fields", async () => {
  const { container, root } = await mount();
  for (const label of [
    "Keepalive interval (seconds)",
    "Connect timeout (seconds)",
    "Terminal type",
  ]) {
    expect(container.textContent).toContain(label);
  }
  expect(container.textContent).not.toContain(
    "configured per-host in the host settings",
  );
  act(() => root.unmount());
});

it("rejects an out-of-range keepalive and accepts 0", async () => {
  const onChange = vi.fn();
  const { container, root } = await mount(onChange);
  const input = container.querySelector<HTMLInputElement>("#ssh-keepalive");
  if (!input) throw new Error("missing keepalive input");
  await act(async () => type(input, "3"));
  expect(container.textContent).toContain("Use 0 (off) or 5–600 seconds");
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => type(input, "0"));
  expect(onChange).toHaveBeenCalledWith("sshKeepaliveSecs", 0);
  act(() => root.unmount());
});

it("renders the SSH agent socket field and reports changes", async () => {
  const onChange = vi.fn();
  const { container, root } = await mount(onChange);
  expect(container.textContent).toContain("SSH agent socket");
  expect(container.textContent).toContain(
    "Leave empty to use the system agent (SSH_AUTH_SOCK, Windows OpenSSH agent or Pageant).",
  );
  const input = container.querySelector<HTMLInputElement>("#ssh-agent-path");
  if (!input) throw new Error("missing agent input");
  await act(async () => type(input, " /run/agent.sock "));
  expect(onChange).toHaveBeenCalledWith("sshAgentPath", "/run/agent.sock");
  act(() => root.unmount());
});
