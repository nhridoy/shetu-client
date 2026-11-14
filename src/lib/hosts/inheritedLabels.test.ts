import { describe, expect, it } from "vitest";
import type { InheritedDefaults } from "./inherited";
import {
  forwardLine,
  keepaliveLine,
  loginLine,
  startupLine,
} from "./inheritedLabels";

const base: InheritedDefaults = {
  hasPassword: false,
  startupKind: null,
  env: [],
};

describe("inheritedLabels", () => {
  it("loginLine", () => {
    const g = { ...base, authFrom: "prod" };
    expect(loginLine({ ...g, authType: "password" })).toBe("Password · prod");
    expect(loginLine({ ...g, authType: "key", keyName: "k1" })).toBe(
      "SSH key 'k1' · prod",
    );
    expect(loginLine({ ...g, authType: "key" })).toBe("SSH key · prod");
    expect(loginLine({ ...g, authType: "both" })).toBe("Password + key · prod");
    expect(loginLine({ ...g, authType: "none" })).toBe("None · prod");
    const none = "No group sets a login — uses agent/none";
    expect(loginLine(base)).toBe(none);
    expect(loginLine(undefined)).toBe(none);
    expect(loginLine({ ...base, authType: "key" })).toBe(none);
  });

  it("keepaliveLine", () => {
    const f = { ...base, keepaliveFrom: "prod" };
    expect(keepaliveLine({ ...f, keepaliveSecs: 30 })).toBe("30s · prod");
    expect(keepaliveLine({ ...f, keepaliveSecs: 0 })).toBe("Off · prod");
    expect(keepaliveLine(base)).toBe("Default");
    expect(keepaliveLine()).toBe("Default");
  });

  it("startupLine", () => {
    const f = { ...base, startupFrom: "prod" };
    expect(startupLine({ ...f, startupKind: "command" })).toBe(
      "runs a command · prod",
    );
    expect(startupLine({ ...f, startupKind: "snippet" })).toBe(
      "runs a snippet · prod",
    );
    expect(startupLine({ ...f, startupKind: "none" })).toBe("Nothing");
    expect(startupLine(base)).toBe("Nothing");
    expect(startupLine()).toBe("Nothing");
  });

  it("forwardLine", () => {
    const f = { ...base, forwardAgentFrom: "prod" };
    expect(forwardLine({ ...f, forwardAgent: true })).toBe("On · prod");
    expect(forwardLine({ ...f, forwardAgent: false })).toBe("Off · prod");
    expect(forwardLine(base)).toBe("Off");
    expect(forwardLine()).toBe("Off");
  });
});
