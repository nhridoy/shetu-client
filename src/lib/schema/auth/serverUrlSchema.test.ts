import { describe, expect, it } from "vitest";
import { serverUrlSchema } from "./serverUrlSchema";

const ok = (serverUrl: string) =>
  serverUrlSchema.safeParse({ serverUrl }).success;

describe("serverUrlSchema", () => {
  it("accepts http(s) URLs and empty (use default)", () => {
    expect(ok("https://sync.example.com")).toBe(true);
    expect(ok("http://localhost:8080")).toBe(true);
    expect(ok("")).toBe(true);
  });

  it("rejects URLs the HTTP client cannot use", () => {
    expect(ok("localhost:8080")).toBe(false);
    expect(ok("ftp://sync.example.com")).toBe(false);
  });
});
