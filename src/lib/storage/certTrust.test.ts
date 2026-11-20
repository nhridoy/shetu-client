import { describe, expect, it } from "vitest";
import {
  parseCertError,
  requestCertTrust,
  useCertTrustStore,
} from "./certTrust";

const prompt = {
  kind: "untrusted" as const,
  host: "nas.lan:5006",
  sha256: "ab".repeat(32),
  previous: null,
};

describe("certTrust", () => {
  it("reads a certificate question from a connect error", () => {
    const raw = `cert:${JSON.stringify(prompt)}`;
    expect(parseCertError(raw)).toEqual(prompt);
    expect(parseCertError(new Error(raw))).toEqual(prompt);
    expect(parseCertError("Couldn't connect: timed out")).toBeNull();
    expect(parseCertError("cert:not json")).toBeNull();
  });

  it("resolves with the user's answer", async () => {
    const answer = requestCertTrust(prompt);
    expect(useCertTrustStore.getState().queue[0]?.prompt).toEqual(prompt);
    useCertTrustStore.getState().answer(true);
    await expect(answer).resolves.toBe(true);
    expect(useCertTrustStore.getState().queue).toHaveLength(0);
    const no = requestCertTrust(prompt);
    useCertTrustStore.getState().answer(false);
    await expect(no).resolves.toBe(false);
  });
});
