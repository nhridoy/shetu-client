import { describe, expect, it } from "vitest";
import { portForwardFormSchema } from "./portForwardFormSchema";

describe("portForwardFormSchema", () => {
  it("accepts all three modes with their required fields", () => {
    expect(
      portForwardFormSchema.safeParse({
        mode: "local",
        name: "web",
        localPort: 8080,
        destinationHost: "localhost",
        destinationPort: 80,
      }).success,
    ).toBe(true);
    expect(
      portForwardFormSchema.safeParse({
        mode: "remote",
        name: "callback",
        remoteBindAddress: "127.0.0.1",
        remotePort: 8080,
        destinationHost: "localhost",
        destinationPort: 80,
      }).success,
    ).toBe(true);
    expect(
      portForwardFormSchema.safeParse({
        mode: "dynamic",
        name: "socks",
        localPort: 1080,
      }).success,
    ).toBe(true);
  });

  it("rejects invalid ports, missing destinations, and unsupported remote binds", () => {
    expect(
      portForwardFormSchema.safeParse({
        mode: "local",
        name: "web",
        localPort: 0,
        destinationHost: "",
        destinationPort: 80,
      }).success,
    ).toBe(false);
    expect(
      portForwardFormSchema.safeParse({
        mode: "remote",
        name: "web",
        remoteBindAddress: "public.example",
        remotePort: 8080,
        destinationHost: "localhost",
        destinationPort: 80,
      }).success,
    ).toBe(false);
    expect(
      portForwardFormSchema.safeParse({
        mode: "dynamic",
        name: "socks",
        localPort: 65536,
      }).success,
    ).toBe(false);
  });
});
