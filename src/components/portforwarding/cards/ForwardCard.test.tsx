import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PortForward } from "@/stores/portforwarding/portForwardingStore";
import { ForwardCard } from "./ForwardCard";

const forward = (over: Partial<PortForward> = {}): PortForward => ({
  id: "f1",
  hostId: "h1",
  mode: "local",
  name: "db",
  localPort: 5432,
  remoteBindAddress: null,
  remotePort: null,
  destinationHost: "localhost",
  destinationPort: 5432,
  autoStart: "off",
  status: { state: "stopped" },
  ...over,
});

const html = (f: PortForward) =>
  renderToStaticMarkup(
    <ForwardCard
      forward={f}
      busy={false}
      onStart={() => {}}
      onStop={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );

describe("ForwardCard", () => {
  it("a reconnecting forward says so and can be stopped", () => {
    const out = html(
      forward({
        status: { state: "reconnecting", error: "SSH connection ended" },
      }),
    );
    expect(out).toContain("Reconnecting…");
    expect(out).toContain("SSH connection ended");
    expect(out).toContain(">Stop<");
    expect(out).not.toContain(">Start<");
  });

  it("an auto-start forward shows the Auto badge with what it means", () => {
    expect(html(forward({ autoStart: "unlock" }))).toContain(
      'title="Starts when Shetu unlocks"',
    );
    expect(html(forward({ autoStart: "terminal" }))).toContain(
      'title="Starts with a terminal to this host"',
    );
    expect(html(forward())).not.toContain(">Auto<");
  });
});
