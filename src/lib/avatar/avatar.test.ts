import { describe, expect, it } from "vitest";
import {
  AVATAR_COLORS,
  avatarColor,
  avatarInitials,
  gravatarUrl,
  safeImageUrl,
} from "./avatar";

describe("avatarInitials", () => {
  it("uses the first letters of the first and last name", () => {
    expect(avatarInitials("Nahid Hridoy")).toBe("NH");
    expect(avatarInitials("  mary  ann  smith ")).toBe("MS");
  });

  it("uses the first two letters of a one-word name", () => {
    expect(avatarInitials("nahid")).toBe("NA");
  });

  it("falls back to the email's local part", () => {
    expect(avatarInitials("", "john.doe@example.com")).toBe("JD");
    expect(avatarInitials(undefined, "johndoe@example.com")).toBe("JO");
  });

  it("returns ? when there is nothing to go on", () => {
    expect(avatarInitials()).toBe("?");
  });
});

describe("avatarColor", () => {
  it("is fixed per seed and comes from the palette", () => {
    expect(avatarColor("user-1")).toBe(avatarColor("user-1"));
    expect(AVATAR_COLORS).toContain(avatarColor("user-1"));
  });

  it("spreads different users across colours", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `user-${i}`);
    expect(new Set(ids.map(avatarColor)).size).toBeGreaterThan(5);
  });
});

describe("gravatarUrl", () => {
  it("hashes the trimmed, lower-cased email with SHA-256 and asks for a 404 when missing", async () => {
    // sha256("foo@example.com")
    const hash =
      "321ba197033e81286fedb719d60d4ed5cecaed170733cb4a92013811afc0e3b6";
    expect(await gravatarUrl("  Foo@Example.COM ", 40)).toBe(
      `https://gravatar.com/avatar/${hash}?s=40&d=404`,
    );
  });
});

describe("safeImageUrl", () => {
  it("keeps only absolute https URLs", () => {
    expect(safeImageUrl("https://avatars.example.com/a.png")).toBe(
      "https://avatars.example.com/a.png",
    );
    for (const bad of [
      "",
      undefined,
      "http://x.com/a.png",
      "javascript:alert(1)",
      "/a.png",
    ]) {
      expect(safeImageUrl(bad)).toBeUndefined();
    }
  });
});
