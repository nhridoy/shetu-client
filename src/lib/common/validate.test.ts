import { describe, expect, it } from "vitest";
import { looksLikePrivateKey } from "./validate";

describe("looksLikePrivateKey", () => {
  it("accepts PuTTY .ppk text", () => {
    expect(
      looksLikePrivateKey(
        "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none",
      ),
    ).toBe(true);
  });
  it("rejects arbitrary text", () => {
    expect(looksLikePrivateKey("hello")).toBe(false);
  });
});
